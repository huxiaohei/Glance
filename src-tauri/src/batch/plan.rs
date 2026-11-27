//! 批量的跳过判定与处理清单：只读文件头，不解码像素。
//! 唯一的例外：转格式时 HEIC / AVIF 的系统解码组件状态未知，先各试解一张小图以确定组件在不在。
use glance_imaging::{SrcFormat, src_format_of};
use glance_syscodec::Kind;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use crate::catalog::details;
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::session::Sessions;
use crate::decode::Decoder;
use crate::state::settings::{SettingsState, batch_dir_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchOp {
    Compress,
    Convert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    Unsupported,
    Animated,
    InOutput,
    NotFound,
    /// 本机缺少这种格式的系统解码组件。
    NoCodec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipItem {
    pub id: u32,
    pub name: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub process: Vec<u32>,
    pub skipped: Vec<SkipItem>,
}

/// 读文件头的字节数：`ftyp` 的兼容品牌可能较长。
const HEAD_LEN: usize = 512;

/// 读文件头；读不了为 None。
fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(HEAD_LEN);
    std::fs::File::open(path)
        .and_then(|f| f.take(HEAD_LEN as u64).read_to_end(&mut head))
        .ok()?;
    Some(head)
}

/// 需要系统解码器的格式。
fn system_kind(f: SrcFormat) -> Option<Kind> {
    match f {
        SrcFormat::Heif => Some(Kind::Heif),
        SrcFormat::Avif => Some(Kind::Avif),
        _ => None,
    }
}

/// 该文件为何不处理；None 表示要处理。`rel` 是相对会话根的路径。
/// `codec_missing` 答这种格式的系统解码组件是否缺失（同 [`crate::decode::codec_missing`]）。
pub fn skip_reason(
    path: &Path,
    rel: &Path,
    op: BatchOp,
    out_dir: &str,
    codec_missing: &dyn Fn(Kind) -> Option<bool>,
) -> Option<SkipReason> {
    let first = rel
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy());
    if first.is_some_and(|f| f.to_lowercase() == out_dir.to_lowercase()) {
        return Some(SkipReason::InOutput);
    }
    let Some(details) = details::image_details(path) else {
        return Some(SkipReason::NotFound);
    };
    let Some(head) = read_head(path) else {
        return Some(SkipReason::NotFound);
    };
    if details.animated {
        return Some(SkipReason::Animated);
    }
    match src_format_of(&head) {
        None => Some(SkipReason::Unsupported),
        Some(SrcFormat::Gif | SrcFormat::Bmp | SrcFormat::Heif | SrcFormat::Avif)
            if op == BatchOp::Compress =>
        {
            Some(SkipReason::Unsupported)
        }
        Some(f) if system_kind(f).is_some_and(|k| codec_missing(k) == Some(true)) => {
            Some(SkipReason::NoCodec)
        }
        Some(_) => None,
    }
}

/// 对选中的文件里状态还不知道的每种系统格式，取第一张试解一次（长边 64），以确定组件在不在。
fn probe_codecs(paths: &[PathBuf], decoder: &Decoder) {
    let mut tried: Vec<Kind> = Vec::new();
    for path in paths {
        if [Kind::Heif, Kind::Avif]
            .iter()
            .all(|&k| tried.contains(&k) || decoder.codecs.missing(k).is_some())
        {
            return;
        }
        let Some(kind) = read_head(path)
            .and_then(|h| src_format_of(&h))
            .and_then(system_kind)
        else {
            continue;
        };
        if tried.contains(&kind) || decoder.codecs.missing(kind).is_some() {
            continue;
        }
        tried.push(kind);
        if let Ok(bytes) = std::fs::read(path) {
            // 结果只用来记下组件状态；解不出来也说明组件在。
            let _ = decoder.thumbnail(&bytes, 64);
        }
    }
}

/// 处理清单。HEIC / AVIF 的组件状态未知时先试解一张（只在转格式时有意义：压缩本就跳过它们）。
pub fn plan(
    registry: &Registry,
    root: &Path,
    ids: &[FileId],
    op: BatchOp,
    out_dir: &str,
    decoder: &Decoder,
) -> BatchPlan {
    let mut out = BatchPlan {
        process: Vec::new(),
        skipped: Vec::new(),
    };
    if op == BatchOp::Convert {
        let paths: Vec<PathBuf> = ids.iter().filter_map(|&id| registry.path(id)).collect();
        probe_codecs(&paths, decoder);
    }
    let codec_missing = |k: Kind| decoder.codecs.missing(k);
    for &id in ids {
        let Some(path) = registry.path(id) else {
            out.skipped.push(SkipItem {
                id: id.0,
                name: String::new(),
                reason: SkipReason::NotFound,
            });
            continue;
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let reason = match path.strip_prefix(root) {
            Ok(rel) => skip_reason(&path, rel, op, out_dir, &codec_missing),
            Err(_) => Some(SkipReason::NotFound),
        };
        match reason {
            None => out.process.push(id.0),
            Some(reason) => out.skipped.push(SkipItem {
                id: id.0,
                name,
                reason,
            }),
        }
    }
    out
}

/// 批量前的清单：哪些处理、哪些跳过及原因。读文件头，放到阻塞线程。
#[tauri::command]
pub async fn batch_plan(
    ids: Vec<u32>,
    op: BatchOp,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    settings: State<'_, SettingsState>,
) -> Result<BatchPlan, String> {
    let registry = Arc::clone(&registry);
    let root = sessions.root();
    let out_dir = batch_dir_name(&settings.get());
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<FileId> = ids.into_iter().map(FileId).collect();
        match root {
            Some(root) => plan(&registry, &root, &ids, op, &out_dir, &Decoder::SYSTEM),
            None => BatchPlan {
                process: Vec::new(),
                skipped: ids
                    .iter()
                    .map(|&id| SkipItem {
                        id: id.0,
                        name: registry
                            .path(id)
                            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                            .unwrap_or_default(),
                        reason: SkipReason::NotFound,
                    })
                    .collect(),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG_HEAD: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn put(dir: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p
    }

    fn dec() -> Decoder {
        crate::decode::no_codec_decoder()
    }

    fn heic_bytes() -> Vec<u8> {
        glance_imaging::heif::testkit::sample(&Default::default())
    }

    #[test]
    fn plan_skips_when_codec_missing() {
        let t = tempfile::tempdir().unwrap();
        let p = put(t.path(), "a.heic", &heic_bytes());
        let rel = Path::new("a.heic");
        assert_eq!(
            skip_reason(&p, rel, BatchOp::Convert, "_o", &|_| Some(true)),
            Some(SkipReason::NoCodec)
        );
        assert_eq!(
            skip_reason(&p, rel, BatchOp::Convert, "_o", &|_| Some(false)),
            None
        );
        // 压缩本就不支持 HEIF：仍报 Unsupported。
        assert_eq!(
            skip_reason(&p, rel, BatchOp::Compress, "_o", &|_| Some(true)),
            Some(SkipReason::Unsupported)
        );
        // 不是 HEIF 的文件不受组件状态影响。
        let png = put(t.path(), "b.png", PNG_HEAD);
        assert_eq!(
            skip_reason(&png, Path::new("b.png"), BatchOp::Convert, "_o", &|_| Some(
                true
            )),
            None
        );
        assert_eq!(
            serde_json::to_value(SkipReason::NoCodec).unwrap(),
            "noCodec"
        );
    }

    #[test]
    fn plan_probes_unknown_codec_state() {
        let t = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let a = reg.register(&put(t.path(), "a.heic", &heic_bytes()));
        let b = reg.register(&put(t.path(), "b.png", PNG_HEAD));
        let c = reg.register(&put(t.path(), "c.heic", &heic_bytes()));
        // 状态未知、试解报 NoCodec：记为缺失，两张 HEIC 都跳过。
        let d = dec();
        let r = plan(&reg, t.path(), &[a, b, c], BatchOp::Convert, "_o", &d);
        assert_eq!(d.codecs.missing(glance_syscodec::Kind::Heif), Some(true));
        assert_eq!(r.process, vec![b.0]);
        let reasons: Vec<_> = r.skipped.iter().map(|s| (s.id, s.reason)).collect();
        assert_eq!(
            reasons,
            vec![(a.0, SkipReason::NoCodec), (c.0, SkipReason::NoCodec)]
        );
        // 试解成功：组件可用，照常处理。
        fn ok(
            _: &[u8],
            _: glance_syscodec::Kind,
            _: u64,
            _: Option<u32>,
        ) -> Result<glance_syscodec::Image, glance_syscodec::CodecError> {
            Ok(glance_syscodec::Image {
                width: 1,
                height: 1,
                rgba: vec![0, 0, 0, 255],
                icc: None,
            })
        }
        let d = Decoder { sys: ok, ..dec() };
        let r = plan(&reg, t.path(), &[a, b, c], BatchOp::Convert, "_o", &d);
        assert_eq!(d.codecs.missing(glance_syscodec::Kind::Heif), Some(false));
        assert_eq!(r.process, vec![a.0, b.0, c.0]);
    }

    fn gif_static() -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&[1, 0, 1, 0, 0, 0, 0]);
        v
    }

    fn bmp() -> Vec<u8> {
        let mut v = b"BM".to_vec();
        v.extend_from_slice(&[0; 60]);
        v
    }

    #[test]
    fn skips_gif_bmp_only_for_compress() {
        let t = tempfile::tempdir().unwrap();
        let g = put(t.path(), "a.gif", &gif_static());
        let b = put(t.path(), "b.bmp", &bmp());
        for p in [&g, &b] {
            let rel = Path::new(p.file_name().unwrap());
            assert_eq!(
                skip_reason(p, rel, BatchOp::Compress, "_o", &|_| None),
                Some(SkipReason::Unsupported)
            );
            assert_eq!(skip_reason(p, rel, BatchOp::Convert, "_o", &|_| None), None);
        }
    }

    #[test]
    fn heif_skipped_for_compress_only() {
        use glance_imaging::heif::testkit::bx;
        let t = tempfile::tempdir().unwrap();
        // 兼容品牌很多的 ftyp：整个盒子超过 64 字节，仍应认得出。
        let mut body = b"heic".to_vec();
        body.extend_from_slice(&[0; 4]);
        for _ in 0..40 {
            body.extend_from_slice(b"mif1");
        }
        body.extend_from_slice(b"heic");
        let mut bytes = bx(b"ftyp", &body);
        assert!(bytes.len() > 64);
        let avif = {
            let mut b = body.clone();
            b[..4].copy_from_slice(b"avif");
            bx(b"ftyp", &b)
        };
        bytes.extend_from_slice(&[0; 32]);
        for (name, data) in [("a.heic", bytes), ("b.avif", avif)] {
            let p = put(t.path(), name, &data);
            let rel = Path::new(name);
            assert_eq!(
                skip_reason(&p, rel, BatchOp::Compress, "_o", &|_| None),
                Some(SkipReason::Unsupported),
                "{name}"
            );
            assert_eq!(
                skip_reason(&p, rel, BatchOp::Convert, "_o", &|_| None),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn skips_animated_for_both() {
        let t = tempfile::tempdir().unwrap();
        // 两帧 GIF：用 image 库不便，手写最小的两帧流。
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&[1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
        for _ in 0..2 {
            v.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]);
        }
        v.push(0x3B);
        let g = put(t.path(), "anim.gif", &v);
        let rel = Path::new("anim.gif");
        for op in [BatchOp::Compress, BatchOp::Convert] {
            assert_eq!(
                skip_reason(&g, rel, op, "_o", &|_| None),
                Some(SkipReason::Animated)
            );
        }
    }

    #[test]
    fn in_output_is_case_insensitive() {
        let t = tempfile::tempdir().unwrap();
        let p = put(t.path(), "x.png", PNG_HEAD);
        assert_eq!(
            skip_reason(
                &p,
                Path::new("_GLANCE_OUTPUT/a.png"),
                BatchOp::Convert,
                "_glance_output",
                &|_| None
            ),
            Some(SkipReason::InOutput)
        );
        assert_eq!(
            skip_reason(
                &p,
                Path::new("sub/_glance_output/a.png"),
                BatchOp::Convert,
                "_glance_output",
                &|_| None
            ),
            None
        );
    }

    #[test]
    fn plan_does_not_decode() {
        let t = tempfile::tempdir().unwrap();
        let mut bad = PNG_HEAD.to_vec();
        bad.extend_from_slice(b"\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89");
        bad.extend_from_slice(b"\0\0\0\x04IDAT\xff\xff\xff\xff\0\0\0\0");
        let p = put(t.path(), "bad.png", &bad);
        let reg = Registry::default();
        let id = reg.register(&p);
        let r = plan(&reg, t.path(), &[id], BatchOp::Compress, "_o", &dec());
        assert_eq!(r.process, vec![id.0]);
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn plan_keeps_order_and_reports_names() {
        let t = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let a = reg.register(&put(t.path(), "a.png", PNG_HEAD));
        let b = reg.register(&put(t.path(), "b.gif", &gif_static()));
        let c = reg.register(&put(t.path(), "c.png", PNG_HEAD));
        let r = plan(&reg, t.path(), &[a, b, c], BatchOp::Compress, "_o", &dec());
        assert_eq!(r.process, vec![a.0, c.0]);
        assert_eq!(
            r.skipped,
            vec![SkipItem {
                id: b.0,
                name: "b.gif".into(),
                reason: SkipReason::Unsupported
            }]
        );
    }

    #[test]
    fn outside_root_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let id = reg.register(&put(other.path(), "a.png", PNG_HEAD));
        let r = plan(&reg, root.path(), &[id], BatchOp::Convert, "_o", &dec());
        assert!(r.process.is_empty());
        assert_eq!(r.skipped[0].reason, SkipReason::NotFound);
        assert_eq!(r.skipped[0].name, "a.png");
    }
}
