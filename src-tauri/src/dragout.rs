//! 把文件拖出窗口：前端只给 `FileId`，路径在这里换算后交给系统拖拽。
//! 换算路径、取缩略图做预览都在命令线程上；只有“发起系统拖拽”这一步在主线程。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use glance_imaging::{ImagingError, RgbaView, decode_rgba, encode_png_lossless, make_thumbnail};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::catalog::registry::{FileId, Registry};
use crate::fileops::fsx::FsError;
use crate::thumbs::{ThumbCache, Thumbs, Tier};

/// 系统拖拽预览图的长边（像素）。
pub const PREVIEW_EDGE: u32 = 96;

/// 拖拽结束的结果，经 Channel 发给前端。
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DragEnd {
    Dropped,
    Cancelled,
}

/// 要拖出的路径：去重（留第一次出现的）、保持顺序；未登记的和磁盘上不是普通文件的跳过；
/// 一个都不剩 → NotFound。
pub fn drag_paths(registry: &Registry, ids: &[u32]) -> Result<Vec<PathBuf>, FsError> {
    let mut seen = HashSet::new();
    let paths: Vec<PathBuf> = ids
        .iter()
        .filter(|&&id| seen.insert(id))
        .filter_map(|&id| registry.path(FileId(id)))
        .filter(|p| p.is_file())
        .collect();
    if paths.is_empty() {
        return Err(FsError::NotFound);
    }
    Ok(paths)
}

/// 预览图：`thumb` 是缓存里的缩略图文件内容。有且能解码就把长边缩到 `PREVIEW_EDGE`（不放大），
/// 否则用 64 × 64 的灰色方块。返回值总是能解码的 PNG（`drag` 解不开预览图会直接崩溃）。
pub fn preview_png(thumb: Option<&[u8]>) -> Vec<u8> {
    thumb
        .and_then(|bytes| scaled_preview(bytes).ok())
        .unwrap_or_else(plain_square)
}

fn scaled_preview(thumb: &[u8]) -> Result<Vec<u8>, ImagingError> {
    let small = make_thumbnail(thumb, PREVIEW_EDGE)?;
    let d = decode_rgba(&small.webp, u64::MAX)?;
    encode_png_lossless(RgbaView {
        width: d.width,
        height: d.height,
        data: &d.rgba,
    }, None)
}

const FALLBACK_EDGE: u32 = 64;

fn plain_square() -> Vec<u8> {
    let data = [128u8, 128, 128, 255].repeat((FALLBACK_EDGE * FALLBACK_EDGE) as usize);
    encode_png_lossless(RgbaView {
        width: FALLBACK_EDGE,
        height: FALLBACK_EDGE,
        data: &data,
    }, None)
    .expect("固定尺寸的纯色方块一定能编码")
}

/// 发起系统拖拽。换算路径、读缓存和编码预览图都在命令线程上，只有发起拖拽在主线程。
/// macOS 上命令在拖拽发起后就返回；Windows 上系统拖拽占住主线程，命令要到松手后才返回，
/// 可能晚于 `on_end`。结束时经 `on_end` 通知前端（发送失败忽略）。
#[tauri::command(async)]
pub fn drag_out(
    ids: Vec<u32>,
    on_end: Channel<DragEnd>,
    app: AppHandle,
    window: tauri::Window,
    registry: State<'_, Arc<Registry>>,
    thumbs: State<'_, Arc<Thumbs>>,
) -> Result<(), FsError> {
    let paths = drag_paths(&registry, &ids)?;
    let thumb = ThumbCache::key_for_file(&paths[0], Tier::S).and_then(|k| thumbs.cache().get(&k));
    let png = preview_png(thumb.as_deref());
    start_system_drag(app, window, paths, png, on_end)
}

/// 在主线程发起拖拽，等“发起”的结果送回。macOS 上发起后立刻送回；Windows 上系统拖拽会占住主线程
/// 直到松手（OLE 的正常行为），结果要到松手后才送回，此时 `on_end` 可能已经发出。（Windows 分支未在本机编译）
#[cfg(not(target_os = "linux"))]
fn start_system_drag(
    app: AppHandle,
    window: tauri::Window,
    paths: Vec<PathBuf>,
    png: Vec<u8>,
    on_end: Channel<DragEnd>,
) -> Result<(), FsError> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let started = drag::start_drag(
            &window,
            drag::DragItem::Files(paths),
            drag::Image::Raw(png),
            move |result, _cursor| {
                let end = match result {
                    drag::DragResult::Dropped => DragEnd::Dropped,
                    drag::DragResult::Cancel => DragEnd::Cancelled,
                };
                let _ = on_end.send(end);
            },
            drag::Options {
                mode: drag::DragMode::Copy,
                ..Default::default()
            },
        );
        let _ = tx.send(started.is_ok());
    })
    .map_err(|_| FsError::Other)?;
    match rx.recv() {
        Ok(true) => Ok(()),
        _ => Err(FsError::Other),
    }
}

/// Linux 不是目标平台。
#[cfg(target_os = "linux")]
fn start_system_drag(
    _app: AppHandle,
    _window: tauri::Window,
    _paths: Vec<PathBuf>,
    _png: Vec<u8>,
    _on_end: Channel<DragEnd>,
) -> Result<(), FsError> {
    Err(FsError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    fn touch(dir: &std::path::Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        p
    }

    /// 宽 × 高的纯色 WebP 缩略图（与缓存里的格式相同）。
    fn thumb_webp(w: u32, h: u32) -> Vec<u8> {
        let data = vec![200u8; (w * h * 4) as usize];
        let png = glance_imaging::encode_png_lossless(RgbaView {
            width: w,
            height: h,
            data: &data,
        }, None)
        .unwrap();
        make_thumbnail(&png, 320).unwrap().webp
    }

    fn size_of_png(bytes: &[u8]) -> (u32, u32) {
        assert!(bytes.starts_with(&PNG_SIGNATURE), "不是 PNG");
        let d = decode_rgba(bytes, u64::MAX).unwrap();
        (d.width, d.height)
    }

    #[test]
    fn drag_paths_keeps_order_dedupes_and_skips_unknown_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let a = registry.register(&touch(dir.path(), "a.png"));
        let b = registry.register(&touch(dir.path(), "b.png"));
        let c = registry.register(&touch(dir.path(), "c.png"));
        std::fs::remove_file(dir.path().join("b.png")).unwrap();
        let paths = drag_paths(&registry, &[c.0, 999, a.0, c.0, b.0]).unwrap();
        assert_eq!(
            paths,
            vec![registry.path(c).unwrap(), registry.path(a).unwrap()]
        );
    }

    #[test]
    fn drag_paths_with_nothing_left_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let gone = registry.register(&dir.path().join("gone.png"));
        assert_eq!(drag_paths(&registry, &[]), Err(FsError::NotFound));
        assert_eq!(drag_paths(&registry, &[999]), Err(FsError::NotFound));
        assert_eq!(drag_paths(&registry, &[gone.0]), Err(FsError::NotFound));
    }

    #[test]
    fn drag_paths_skips_directories() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let d = registry.register(&sub);
        let f = registry.register(&touch(dir.path(), "f.png"));
        assert_eq!(drag_paths(&registry, &[d.0]), Err(FsError::NotFound));
        assert_eq!(
            drag_paths(&registry, &[d.0, f.0]).unwrap(),
            vec![registry.path(FileId(f.0)).unwrap()]
        );
    }

    #[test]
    fn preview_from_thumbnail_is_png_within_edge() {
        let thumb = thumb_webp(320, 200);
        assert_eq!(size_of_png(&preview_png(Some(&thumb))), (96, 60));
    }

    #[test]
    fn preview_keeps_small_thumbnails_unscaled() {
        let thumb = thumb_webp(40, 30);
        assert_eq!(size_of_png(&preview_png(Some(&thumb))), (40, 30));
    }

    #[test]
    fn preview_falls_back_to_plain_square() {
        assert_eq!(size_of_png(&preview_png(None)), (64, 64));
        assert_eq!(size_of_png(&preview_png(Some(&[]))), (64, 64));
        assert_eq!(
            size_of_png(&preview_png(Some(b"definitely not an image"))),
            (64, 64)
        );
    }

    #[test]
    fn drag_end_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&DragEnd::Dropped).unwrap(),
            "\"dropped\""
        );
        assert_eq!(
            serde_json::to_string(&DragEnd::Cancelled).unwrap(),
            "\"cancelled\""
        );
    }
}
