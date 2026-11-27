//! 开发期实验命令，仅 debug 构建编译。

use crate::catalog::registry::Registry;
use crate::decode::{DISPLAY_MAX_EDGE, Decoder};
use crate::fileops::trash::{self, TrashHandle};
use crate::protocol::HITS;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::State;

#[derive(serde::Serialize)]
pub struct LabEntry {
    pub id: u32,
    pub name: String,
    pub size: u64,
}

/// 登记目录下一层（不递归）的全部文件。
#[tauri::command]
pub async fn lab_register_dir(
    registry: State<'_, Arc<Registry>>,
    path: String,
) -> Result<Vec<LabEntry>, String> {
    let dir = PathBuf::from(path);
    let mut files: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| (entry.path(), meta.len()))
        })
        .collect();
    files.sort();
    Ok(files
        .into_iter()
        .map(|(path, size)| LabEntry {
            id: registry.register(&path).0,
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size,
        })
        .collect())
}

#[tauri::command]
pub fn lab_protocol_hits() -> u64 {
    HITS.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn lab_trash(path: String) -> Result<TrashHandle, String> {
    trash::move_to_trash(&PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lab_restore(handle: TrashHandle) -> Result<(), String> {
    trash::restore(&handle).map_err(|e| e.to_string())
}

/// HEIC 实验读数：三段耗时分别是读文件、系统解码（显示通道的设置：长边不超过 8000）、不压缩 PNG 编码。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeicProbe {
    pub read_ms: f64,
    pub decode_ms: f64,
    pub encode_ms: f64,
    pub png_bytes: usize,
    /// 解码出来的宽高（已按文件记录的方向摆正，长边超过 8000 时是缩小后的）。
    pub width: u32,
    pub height: u32,
    /// `heif::parse` 的 `display_dims`；文件头读不出来为 None。
    pub header_dims: Option<(u32, u32)>,
    pub has_icc: bool,
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// 不是 HEIC / HEIF / AVIF（`ftyp` 品牌不认识）返回 Err；其余错误也以文字返回。
pub fn heic_probe_with(path: &Path, decoder: &Decoder) -> Result<HeicProbe, String> {
    let t = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let read_ms = ms(t);

    let kind = match glance_imaging::heif::sniff(&bytes) {
        Some(glance_imaging::heif::HeifKind::Heic) => glance_syscodec::Kind::Heif,
        Some(glance_imaging::heif::HeifKind::Avif) => glance_syscodec::Kind::Avif,
        None => return Err("不是 HEIC / HEIF / AVIF 文件".into()),
    };
    let header_dims = glance_imaging::heif::parse(&mut std::io::Cursor::new(&bytes))
        .map(|info| info.display_dims());

    let t = Instant::now();
    let img = (decoder.sys)(&bytes, kind, u64::MAX, Some(DISPLAY_MAX_EDGE))
        .map_err(|e| format!("系统解码失败：{e:?}"))?;
    let decode_ms = ms(t);

    let t = Instant::now();
    let png = glance_imaging::encode_png_stored(
        glance_imaging::RgbaView {
            width: img.width,
            height: img.height,
            data: &img.rgba,
        },
        img.icc.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    let encode_ms = ms(t);

    Ok(HeicProbe {
        read_ms,
        decode_ms,
        encode_ms,
        png_bytes: png.len(),
        width: img.width,
        height: img.height,
        header_dims,
        has_icc: img.icc.is_some(),
    })
}

/// 读文件与解码都在阻塞线程池里，不占主线程。
#[tauri::command]
pub async fn lab_heic_probe(path: String) -> Result<HeicProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        heic_probe_with(Path::new(&path), &Decoder::SYSTEM)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_heif_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        std::fs::write(&p, b"\x89PNG\r\n\x1a\nnot really").unwrap();
        let err = heic_probe_with(&p, &Decoder::SYSTEM).unwrap_err();
        assert!(err.contains("不是 HEIC"), "{err}");
        assert!(heic_probe_with(&dir.path().join("missing"), &Decoder::SYSTEM).is_err());
    }

    #[cfg(target_os = "macos")]
    mod mac {
        use super::*;
        use std::ffi::c_void;

        use objc2_core_foundation::{
            CFArray, CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType,
        };
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImageAlphaInfo,
            kCGColorSpaceSRGB,
        };
        use objc2_image_io::{CGImageDestination, kCGImageDestinationLossyCompressionQuality};

        const W: u32 = 64;
        const H: u32 = 48;

        /// 与 tests/heic_display.rs 同一做法：W×H 的不透明渐变编成 HEIC；编码器不可用时 Err(原因)。
        fn heic() -> Result<Vec<u8>, String> {
            let mut px = Vec::with_capacity((W * H * 4) as usize);
            for y in 0..H {
                for x in 0..W {
                    px.extend_from_slice(&[(x * 4) as u8, (y * 5) as u8, 128, 255]);
                }
            }
            let uti = CFString::from_str("public.heic");
            // SAFETY: 位图上下文借用 `px` 的缓冲，宽高与行字节数与缓冲一致；
            // 上下文与由它生成的 CGImage（CoreGraphics 会复制像素）都在 `px` 释放前用完。
            unsafe {
                let available = CGImageDestination::type_identifiers();
                let available: &CFArray<CFType> = available.cast_unchecked();
                if !available
                    .iter()
                    .any(|t| t.downcast_ref::<CFString>().is_some_and(|s| *s == *uti))
                {
                    return Err("本机 CGImageDestination 不支持 public.heic".into());
                }
                let space = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)).ok_or("没有 sRGB")?;
                let ctx = CGBitmapContextCreate(
                    px.as_mut_ptr() as *mut c_void,
                    W as usize,
                    H as usize,
                    8,
                    (W * 4) as usize,
                    Some(&space),
                    CGImageAlphaInfo::NoneSkipLast.0,
                )
                .ok_or("建位图上下文失败")?;
                let image = CGBitmapContextCreateImage(Some(&ctx)).ok_or("取 CGImage 失败")?;
                let data = CFMutableData::new(None, 0).ok_or("建 CFMutableData 失败")?;
                let dest = CGImageDestination::with_data(&data, &uti, 1, None)
                    .ok_or("CGImageDestination 不接受 HEIC")?;
                let quality = CFNumber::new_f64(0.9);
                let opts: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
                    &[kCGImageDestinationLossyCompressionQuality],
                    &[quality.as_ref()],
                );
                dest.add_image(&image, Some(opts.as_opaque()));
                if !dest.finalize() {
                    return Err("HEIC 编码失败（finalize 返回 false）".into());
                }
                Ok(data.to_vec())
            }
        }

        #[test]
        fn real_heic_is_probed() {
            let bytes = match heic() {
                Ok(b) => b,
                Err(why) => {
                    eprintln!("跳过：{why}");
                    return;
                }
            };
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("a.heic");
            std::fs::write(&p, &bytes).unwrap();
            let r = heic_probe_with(&p, &Decoder::SYSTEM).unwrap();
            assert_eq!((r.width, r.height), (W, H));
            assert_eq!(r.header_dims, Some((W, H)));
            assert!(r.png_bytes >= (W * H * 4) as usize);
            assert!(r.read_ms >= 0.0 && r.decode_ms > 0.0 && r.encode_ms >= 0.0);
            let json = serde_json::to_value(&r).unwrap();
            for k in [
                "readMs",
                "decodeMs",
                "encodeMs",
                "pngBytes",
                "width",
                "height",
                "headerDims",
                "hasIcc",
            ] {
                assert!(json.get(k).is_some(), "缺字段 {k}");
            }
        }
    }
}
