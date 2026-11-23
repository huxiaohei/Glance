//! 一次“打开目录”的完整流程：扫描登记、分批推送、补齐尺寸。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::events::{CatalogEvent, Dim, Entry, OpenError};
use super::registry::Registry;
use super::scan::{is_image_path, scan};

#[derive(Debug, PartialEq)]
pub struct OpenTarget {
    pub root: PathBuf,
    pub recursive: bool,
    pub focus_file: Option<PathBuf>,
}

/// 目录 → 以它为根，recursive 取调用方给的值。
/// 图片文件 → 以父目录为根，recursive 固定为 false，focus_file 为该文件。
/// 不存在 → NotFound；存在但既非目录也非支持的图片 → NotAnImage；
/// 元数据读不出（如无权限）→ Unreadable。
pub fn resolve_open_target(path: &Path, recursive: bool) -> Result<OpenTarget, OpenError> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => OpenError::NotFound,
        _ => OpenError::Unreadable,
    })?;
    if meta.is_dir() {
        return Ok(OpenTarget {
            root: path.to_path_buf(),
            recursive,
            focus_file: None,
        });
    }
    if meta.is_file() && is_image_path(path) {
        let parent = path.parent().ok_or(OpenError::NotAnImage)?;
        return Ok(OpenTarget {
            root: parent.to_path_buf(),
            recursive: false,
            focus_file: Some(path.to_path_buf()),
        });
    }
    Err(OpenError::NotAnImage)
}

pub const DIMS_BATCH: usize = 256;

fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 一次完整的打开：扫描并登记，逐批发 Batch，结束发 Done，随后只读文件头
/// 并行补齐尺寸，分批发 Dims（读不出尺寸的文件不出现在 Dims 里）。
/// 取消是尽力而为：cancel 置位后会尽快停止，但已在途的少量事件仍可能发出；
/// 它们带着旧的 generation，消费方据此丢弃。
pub fn run(
    generation: u32,
    target: &OpenTarget,
    registry: &Registry,
    cancel: &AtomicBool,
    emit: &(dyn Fn(CatalogEvent) + Sync),
) {
    // 每次发出前检查取消；取消后什么都不发。
    let send = |event: CatalogEvent| -> bool {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        emit(event);
        true
    };

    let mut registered: Vec<(u32, PathBuf)> = Vec::new();
    let mut emitted = 0usize;
    scan(&target.root, target.recursive, cancel, &mut |batch| {
        let entries: Vec<Entry> = batch
            .into_iter()
            .map(|item| {
                let id = registry.register(&item.path).0;
                let rel_path = rel_path(&target.root, &item.path);
                registered.push((id, item.path));
                Entry {
                    id,
                    rel_path,
                    size: item.size,
                    mtime_ms: item.mtime_ms,
                }
            })
            .collect();
        let n = entries.len();
        if send(CatalogEvent::Batch { generation, entries }) {
            emitted += n;
        }
    });
    if !send(CatalogEvent::Done {
        generation,
        total: emitted,
    }) {
        return;
    }

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let chunk_len = registered.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        for chunk in registered.chunks(chunk_len) {
            let send = &send;
            scope.spawn(move || {
                let mut items: Vec<Dim> = Vec::new();
                for (id, path) in chunk {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(size) = imagesize::size(path) {
                        items.push(Dim {
                            id: *id,
                            w: size.width as u32,
                            h: size.height as u32,
                        });
                        if items.len() >= DIMS_BATCH
                            && !send(CatalogEvent::Dims {
                                generation,
                                items: std::mem::take(&mut items),
                            })
                        {
                            return;
                        }
                    }
                }
                if !items.is_empty() {
                    send(CatalogEvent::Dims { generation, items });
                }
            });
        }
    });
}

struct Current {
    generation: u32,
    cancel: Option<Arc<AtomicBool>>,
}

/// 管理“当前这一次打开”。
pub struct Sessions {
    current: Mutex<Current>,
}

impl Default for Sessions {
    fn default() -> Self {
        Self {
            current: Mutex::new(Current {
                generation: 0,
                cancel: None,
            }),
        }
    }
}

impl Sessions {
    /// 取消上一次并返回新的代号与取消标志。
    pub fn begin(&self) -> (u32, Arc<AtomicBool>) {
        let mut cur = self.current.lock().unwrap();
        if let Some(prev) = cur.cancel.take() {
            prev.store(true, Ordering::Relaxed);
        }
        cur.generation += 1;
        let cancel = Arc::new(AtomicBool::new(false));
        cur.cancel = Some(cancel.clone());
        (cur.generation, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glance_imaging::{RgbaView, encode_png_lossless};
    use std::collections::BTreeSet;
    use std::fs;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let data = vec![255u8; (w * h * 4) as usize];
        encode_png_lossless(RgbaView { width: w, height: h, data: &data }).unwrap()
    }

    #[test]
    fn directory_target_keeps_requested_recursion() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert_eq!(
            resolve_open_target(dir, true).unwrap(),
            OpenTarget { root: dir.to_path_buf(), recursive: true, focus_file: None }
        );
        assert!(!resolve_open_target(dir, false).unwrap().recursive);
    }

    #[test]
    fn image_target_opens_parent_non_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let file = dir.join("a.PNG");
        fs::write(&file, png(1, 1)).unwrap();
        assert_eq!(
            resolve_open_target(&file, true).unwrap(),
            OpenTarget {
                root: dir.to_path_buf(),
                recursive: false,
                focus_file: Some(file.clone())
            }
        );
    }

    #[test]
    fn bad_targets_are_classified() {
        assert_eq!(
            resolve_open_target(Path::new("/definitely/not/here"), true),
            Err(OpenError::NotFound)
        );
        let tmp = tempfile::tempdir().unwrap();
        let txt = tmp.path().join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        assert_eq!(resolve_open_target(&txt, true), Err(OpenError::NotAnImage));
    }

    #[test]
    fn run_emits_batches_then_done_then_dims() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("a.png"), png(4, 2)).unwrap();
        fs::create_dir(dir.join("子 目录")).unwrap();
        fs::write(dir.join("子 目录/b.png"), png(3, 5)).unwrap();
        fs::write(dir.join("broken.png"), "x").unwrap();

        let registry = Registry::default();
        let events = Mutex::new(Vec::<CatalogEvent>::new());
        let target = OpenTarget { root: dir.to_path_buf(), recursive: true, focus_file: None };
        run(9, &target, &registry, &AtomicBool::new(false), &|e| {
            events.lock().unwrap().push(e)
        });
        let events = events.into_inner().unwrap();

        let done_at = events
            .iter()
            .position(|e| matches!(e, CatalogEvent::Done { .. }))
            .unwrap();
        assert_eq!(events[done_at], CatalogEvent::Done { generation: 9, total: 3 });
        assert_eq!(
            events.iter().filter(|e| matches!(e, CatalogEvent::Done { .. })).count(),
            1
        );
        for (i, e) in events.iter().enumerate() {
            match e {
                CatalogEvent::Batch { .. } => assert!(i < done_at),
                CatalogEvent::Dims { .. } => assert!(i > done_at),
                CatalogEvent::Done { .. } => {}
            }
        }

        let mut rels = BTreeSet::new();
        let mut dims = vec![];
        for e in &events {
            match e {
                CatalogEvent::Batch { generation, entries } => {
                    assert_eq!(*generation, 9);
                    for en in entries {
                        let abs = registry.path(crate::catalog::registry::FileId(en.id)).unwrap();
                        assert_eq!(abs, dir.join(&en.rel_path));
                        rels.insert(en.rel_path.clone());
                    }
                }
                CatalogEvent::Dims { generation, items } => {
                    assert_eq!(*generation, 9);
                    for d in items {
                        let abs = registry.path(crate::catalog::registry::FileId(d.id)).unwrap();
                        dims.push((abs.file_name().unwrap().to_string_lossy().into_owned(), d.w, d.h));
                    }
                }
                CatalogEvent::Done { generation, .. } => assert_eq!(*generation, 9),
            }
        }
        assert_eq!(
            rels,
            BTreeSet::from(["a.png".to_string(), "子 目录/b.png".to_string(), "broken.png".to_string()])
        );
        dims.sort();
        assert_eq!(dims, vec![("a.png".to_string(), 4, 2), ("b.png".to_string(), 3, 5)]);
    }

    #[test]
    fn run_emits_nothing_after_cancel() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for i in 0..1201 {
            fs::write(dir.join(format!("{i}.png")), [0u8]).unwrap();
        }
        let registry = Registry::default();
        let cancel = AtomicBool::new(false);
        let events = Mutex::new(Vec::<CatalogEvent>::new());
        let target = OpenTarget { root: dir.to_path_buf(), recursive: false, focus_file: None };
        run(1, &target, &registry, &cancel, &|e| {
            events.lock().unwrap().push(e);
            cancel.store(true, Ordering::Relaxed);
        });
        let events = events.into_inner().unwrap();
        assert_eq!(events.len(), 1);
        assert!(!matches!(events[0], CatalogEvent::Done { .. }));
    }

    #[test]
    fn begin_cancels_the_previous_session() {
        let s = Sessions::default();
        let (g1, c1) = s.begin();
        let (g2, c2) = s.begin();
        assert_eq!(g2, g1 + 1);
        assert!(c1.load(Ordering::Relaxed));
        assert!(!c2.load(Ordering::Relaxed));
    }
}
