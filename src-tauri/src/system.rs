//! 与系统交互的命令：复制图片、复制路径到剪贴板，在访达 / 资源管理器中显示。
//! 命令只从 `FileId` 换算路径，路径字符串不回到前端；主体写成不依赖剪贴板的函数以便测试。

use std::sync::Arc;

use glance_imaging::{Decoded, ImagingError};
use tauri::image::Image;
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::catalog::registry::{FileId, Registry};
use crate::fileops::fsx::FsError;

/// 复制到剪贴板的图片像素数上限（宽 × 高）。
const CLIPBOARD_MAX_PIXELS: u64 = 100_000_000;

/// 读出并解码要复制的图片。未登记或文件不存在 → NotFound；超过像素上限 → TooLarge；
/// 解码失败 → Other；其他读文件错误按 io 错误归类。
pub fn load_for_clipboard(registry: &Registry, id: u32) -> Result<Decoded, FsError> {
    let path = registry.path(FileId(id)).ok_or(FsError::NotFound)?;
    let bytes = std::fs::read(&path).map_err(|e| FsError::from(&e))?;
    glance_imaging::decode_rgba(&bytes, CLIPBOARD_MAX_PIXELS).map_err(|e| match e {
        ImagingError::TooLarge => FsError::TooLarge,
        _ => FsError::Other,
    })
}

/// 已登记的那些 id 的路径，按输入顺序以换行连接，末尾不带换行；未登记的跳过，一个都没有 → NotFound。
pub fn paths_text(registry: &Registry, ids: &[u32]) -> Result<String, FsError> {
    let paths: Vec<String> = ids
        .iter()
        .filter_map(|&id| registry.path(FileId(id)))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return Err(FsError::NotFound);
    }
    Ok(paths.join("\n"))
}

/// 读文件、解码和写剪贴板都在命令的工作线程上（arboard 不要求主线程）。
#[tauri::command(async)]
pub fn clipboard_copy_image(
    id: u32,
    app: AppHandle,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), FsError> {
    let d = load_for_clipboard(&registry, id)?;
    let image = Image::new_owned(d.rgba, d.width, d.height);
    app.clipboard()
        .write_image(&image)
        .map_err(|_| FsError::Other)
}

#[tauri::command(async)]
pub fn clipboard_copy_paths(
    ids: Vec<u32>,
    app: AppHandle,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), FsError> {
    let text = paths_text(&registry, &ids)?;
    app.clipboard().write_text(text).map_err(|_| FsError::Other)
}

/// 在访达 / 资源管理器里选中该文件。
#[tauri::command(async)]
pub fn reveal(id: u32, registry: State<'_, Arc<Registry>>) -> Result<(), FsError> {
    let path = registry.path(FileId(id)).ok_or(FsError::NotFound)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| FsError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_text_joins_registered_paths_with_newlines_and_skips_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let a = registry.register(&dir.path().join("a.png"));
        let b = registry.register(&dir.path().join("b.png"));
        let text = paths_text(&registry, &[b.0, 999, a.0]).unwrap();
        let expected = format!(
            "{}\n{}",
            dir.path().join("b.png").display(),
            dir.path().join("a.png").display()
        );
        assert_eq!(text, expected);
        assert_eq!(paths_text(&registry, &[999, 1000]), Err(FsError::NotFound));
        assert_eq!(paths_text(&registry, &[]), Err(FsError::NotFound));
    }

    #[test]
    fn copy_image_of_an_unregistered_id_is_not_found() {
        let registry = Registry::default();
        assert_eq!(
            load_for_clipboard(&registry, 999).err(),
            Some(FsError::NotFound)
        );
    }

    #[test]
    fn copy_image_reports_missing_garbage_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let missing = registry.register(&dir.path().join("gone.png"));
        assert_eq!(
            load_for_clipboard(&registry, missing.0).err(),
            Some(FsError::NotFound)
        );

        let garbage = dir.path().join("garbage.png");
        std::fs::write(&garbage, b"not an image").unwrap();
        let garbage = registry.register(&garbage);
        assert_eq!(
            load_for_clipboard(&registry, garbage.0).err(),
            Some(FsError::Other)
        );

        // 只有文件头的 PNG：声称 20000 × 10000，超过上限，不会真去解码
        let huge = dir.path().join("huge.png");
        std::fs::write(&huge, png_header(20_000, 10_000)).unwrap();
        let huge = registry.register(&huge);
        assert_eq!(
            load_for_clipboard(&registry, huge.0).err(),
            Some(FsError::TooLarge)
        );
    }

    #[test]
    fn copy_image_decodes_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let p = dir.path().join("small.png");
        let data = vec![7u8; 3 * 2 * 4];
        let png = glance_imaging::encode_png_lossless(glance_imaging::RgbaView {
            width: 3,
            height: 2,
            data: &data,
        })
        .unwrap();
        std::fs::write(&p, png).unwrap();
        let id = registry.register(&p);
        let d = load_for_clipboard(&registry, id.0).unwrap();
        assert_eq!((d.width, d.height, d.rgba.len()), (3, 2, 24));
    }

    /// PNG 签名、IHDR 块和一个空的 IDAT 块：读得出尺寸，没有可解码的像素。
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut chunk = b"IHDR".to_vec();
        chunk.extend_from_slice(&w.to_be_bytes());
        chunk.extend_from_slice(&h.to_be_bytes());
        chunk.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 位 RGBA
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(&chunk);
        out.extend_from_slice(&crc32(&chunk).to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(b"IDAT");
        out.extend_from_slice(&crc32(b"IDAT").to_be_bytes());
        out
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
}
