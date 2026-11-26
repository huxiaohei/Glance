//! 批量的跳过判定与处理清单：只读文件头，不解码像素。
use glance_imaging::{SrcFormat, src_format_of};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::catalog::details;
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::session::Sessions;
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

/// 该文件为何不处理；None 表示要处理。`rel` 是相对会话根的路径。
pub fn skip_reason(path: &Path, rel: &Path, op: BatchOp, out_dir: &str) -> Option<SkipReason> {
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
    let mut head = Vec::with_capacity(64);
    match std::fs::File::open(path).and_then(|f| f.take(64).read_to_end(&mut head)) {
        Ok(_) => {}
        Err(_) => return Some(SkipReason::NotFound),
    }
    if details.animated {
        return Some(SkipReason::Animated);
    }
    match src_format_of(&head) {
        None => Some(SkipReason::Unsupported),
        Some(SrcFormat::Gif | SrcFormat::Bmp) if op == BatchOp::Compress => {
            Some(SkipReason::Unsupported)
        }
        Some(_) => None,
    }
}

pub fn plan(
    registry: &Registry,
    root: &Path,
    ids: &[FileId],
    op: BatchOp,
    out_dir: &str,
) -> BatchPlan {
    let mut out = BatchPlan {
        process: Vec::new(),
        skipped: Vec::new(),
    };
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
            Ok(rel) => skip_reason(&path, rel, op, out_dir),
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
            Some(root) => plan(&registry, &root, &ids, op, &out_dir),
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
    use std::path::PathBuf;

    const PNG_HEAD: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn put(dir: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p
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
                skip_reason(p, rel, BatchOp::Compress, "_o"),
                Some(SkipReason::Unsupported)
            );
            assert_eq!(skip_reason(p, rel, BatchOp::Convert, "_o"), None);
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
            assert_eq!(skip_reason(&g, rel, op, "_o"), Some(SkipReason::Animated));
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
                "_glance_output"
            ),
            Some(SkipReason::InOutput)
        );
        assert_eq!(
            skip_reason(
                &p,
                Path::new("sub/_glance_output/a.png"),
                BatchOp::Convert,
                "_glance_output"
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
        let r = plan(&reg, t.path(), &[id], BatchOp::Compress, "_o");
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
        let r = plan(&reg, t.path(), &[a, b, c], BatchOp::Compress, "_o");
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
        let r = plan(&reg, root.path(), &[id], BatchOp::Convert, "_o");
        assert!(r.process.is_empty());
        assert_eq!(r.skipped[0].reason, SkipReason::NotFound);
        assert_eq!(r.skipped[0].name, "a.png");
    }
}
