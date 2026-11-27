//! 一次“打开目录”的完整流程：扫描登记、分批推送、补齐尺寸。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use super::details::display_size;
use super::events::{CatalogEvent, Dim, Entry, OpenError};
use super::reconcile::FsHint;
use super::registry::Registry;
use super::scan::{Stamp, is_image_path, scan};
use super::watch::SessionMsg;

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
///
/// 非 Windows 上根目录取规范路径（解开符号链接，macOS 上如 /var → /private/var），
/// 因为监听器报告的是规范路径，登记表、已知条目与监听事件必须是同一种形式；
/// focus_file 为规范化的父目录加原文件名。Windows 上保持原样（规范化会加 `\\?\` 前缀）。
/// 显示用的名字另见 [`root_display_name`]。
pub fn resolve_open_target(path: &Path, recursive: bool) -> Result<OpenTarget, OpenError> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => OpenError::NotFound,
        _ => OpenError::Unreadable,
    })?;
    if meta.is_dir() {
        return Ok(OpenTarget {
            root: canonical_dir(path)?,
            recursive,
            focus_file: None,
        });
    }
    if meta.is_file() && is_image_path(path) {
        let parent = path.parent().ok_or(OpenError::NotAnImage)?;
        let name = path.file_name().ok_or(OpenError::NotAnImage)?;
        let root = canonical_dir(parent)?;
        return Ok(OpenTarget {
            focus_file: Some(root.join(name)),
            root,
            recursive: false,
        });
    }
    Err(OpenError::NotAnImage)
}

/// 目录会话与添加面板“其他文件夹”共用的规范化：同一文件不论经哪种写法打开，登记成同一个 `FileId`。
#[cfg(not(windows))]
pub(crate) fn canonical_dir(dir: &Path) -> Result<PathBuf, OpenError> {
    std::fs::canonicalize(dir).map_err(|_| OpenError::Unreadable)
}

#[cfg(windows)]
pub(crate) fn canonical_dir(dir: &Path) -> Result<PathBuf, OpenError> {
    Ok(dir.to_path_buf())
}

/// 界面上显示的根目录名：取用户给的路径（打开图片时取其父目录）的最后一级，
/// 所以经符号链接打开的目录显示链接自己的名字；取不到（如 `/`）时用根目录完整路径。
pub fn root_display_name(requested: &Path, target: &OpenTarget) -> String {
    let base = if target.focus_file.is_some() {
        requested.parent()
    } else {
        Some(requested)
    };
    base.and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| target.root.to_string_lossy().into_owned())
}

pub const DIMS_BATCH: usize = 256;

pub(crate) fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 一次完整的打开：扫描并登记，逐批发 Batch，结束发 Done，随后只读文件头
/// 并行补齐尺寸（按 EXIF 方向转正后的显示尺寸，见 [`display_size`]），分批发 Dims（读不出尺寸的文件不出现在 Dims 里）。
/// 取消是尽力而为：cancel 置位后会尽快停止，但已在途的少量事件仍可能发出；
/// 它们带着旧的 generation，消费方据此丢弃。
///
/// 返回已登记并推送给前端的条目（路径 → id 与扫描时的版本），供之后的监听比对；
/// 扫描期间被取消时返回空表。
pub fn run(
    generation: u32,
    target: &OpenTarget,
    registry: &Registry,
    cancel: &AtomicBool,
    emit: &(dyn Fn(CatalogEvent) + Sync),
) -> HashMap<PathBuf, (u32, Stamp)> {
    // 每次发出前检查取消；取消是尽力而为，见上方文档注释
    let send = |event: CatalogEvent| -> bool {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        emit(event);
        true
    };

    let mut registered: Vec<(u32, PathBuf)> = Vec::new();
    let mut known: HashMap<PathBuf, (u32, Stamp)> = HashMap::new();
    let mut emitted = 0usize;
    scan(&target.root, target.recursive, cancel, &mut |batch| {
        let entries: Vec<Entry> = batch
            .into_iter()
            .map(|item| {
                let id = registry.register(&item.path).0;
                let rel_path = rel_path(&target.root, &item.path);
                let stamp = Stamp {
                    size: item.size,
                    mtime_ms: item.mtime_ms,
                };
                known.insert(item.path.clone(), (id, stamp));
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
        return HashMap::new();
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
                    if let Some((w, h)) = display_size(path) {
                        items.push(Dim { id: *id, w, h });
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
    if cancel.load(Ordering::Relaxed) {
        return HashMap::new();
    }
    known
}

struct Current {
    generation: u32,
    /// 见过的最大请求序号。
    seen: u64,
    cancel: Option<Arc<AtomicBool>>,
    /// 当前会话的根目录与收件口（attach 之后才有）。
    attached: Option<(PathBuf, Sender<SessionMsg>)>,
    /// 当前会话是否包含子目录。
    recursive: bool,
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
                seen: 0,
                cancel: None,
                attached: None,
                recursive: false,
            }),
        }
    }
}

impl Sessions {
    /// 记下见过的最大序号，不取消任何会话。
    pub fn note(&self, seq: u64) {
        let mut cur = self.current.lock().unwrap();
        cur.seen = cur.seen.max(seq);
    }

    /// `seq` 小于见过的最大序号时返回 `None`（已有更新的请求），不动当前会话；
    /// 否则取消上一次并返回新的代号与取消标志。
    pub fn begin(&self, seq: u64) -> Option<(u32, Arc<AtomicBool>)> {
        let mut cur = self.current.lock().unwrap();
        if seq < cur.seen {
            return None;
        }
        cur.seen = seq;
        if let Some(prev) = cur.cancel.take() {
            prev.store(true, Ordering::Relaxed);
        }
        cur.attached = None;
        cur.generation += 1;
        // 每次打开（启动参数、拖入、最近目录、对话框、刷新）都重新探测系统解码组件：
        // 用户可能刚装好组件。
        crate::decode::reset_codec_state();
        let cancel = Arc::new(AtomicBool::new(false));
        cur.cancel = Some(cancel.clone());
        Some((cur.generation, cancel))
    }

    /// begin 之后调用：记下当前会话的根目录、是否含子目录与收件口。下一次 begin 时清掉。
    /// `generation` 已不是当前会话（期间又有新的 begin）时忽略。
    pub fn attach_scoped(
        &self,
        generation: u32,
        root: PathBuf,
        recursive: bool,
        tx: Sender<SessionMsg>,
    ) {
        let mut cur = self.current.lock().unwrap();
        if cur.generation == generation && cur.cancel.is_some() {
            cur.attached = Some((root, tx));
            cur.recursive = recursive;
        }
    }

    /// 测试用：含子目录的 [`attach_scoped`](Self::attach_scoped)。
    #[cfg(test)]
    pub fn attach(&self, generation: u32, root: PathBuf, tx: Sender<SessionMsg>) {
        self.attach_scoped(generation, root, true, tx);
    }

    /// path 是否落在当前会话的范围里（与监听的范围一致：根之下、未被跳过、不含子目录时须是根的直接下级）。
    /// 没有会话时为 false。
    pub fn contains(&self, path: &Path) -> bool {
        let cur = self.current.lock().unwrap();
        let Some((root, _)) = &cur.attached else {
            return false;
        };
        path != root
            && path.starts_with(root)
            && (cur.recursive || path.parent() == Some(root.as_path()))
            && !crate::catalog::scan::is_skipped_path(root, path)
    }

    /// 当前会话的根目录；没有会话返回 None。
    pub fn root(&self) -> Option<PathBuf> {
        let cur = self.current.lock().unwrap();
        cur.attached.as_ref().map(|(root, _)| root.clone())
    }

    /// 当前会话的代号与根目录；没有已 attach 的会话返回 None。
    pub fn current(&self) -> Option<(u32, PathBuf)> {
        let cur = self.current.lock().unwrap();
        cur.attached
            .as_ref()
            .map(|(root, _)| (cur.generation, root.clone()))
    }

    /// 把提示投给当前会话；没有会话或会话已结束时什么都不做。
    pub fn hint(&self, hints: Vec<FsHint>) {
        let cur = self.current.lock().unwrap();
        if let Some((_, tx)) = &cur.attached {
            // 会话线程已退出时发送失败，不是错误
            let _ = tx.send(SessionMsg::Hints(hints));
        }
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
        encode_png_lossless(RgbaView { width: w, height: h, data: &data }, None).unwrap()
    }

    /// 期望的根目录形式：非 Windows 上是规范路径（macOS 的临时目录在 /private/var 下）。
    fn canonical(p: &Path) -> PathBuf {
        if cfg!(windows) { p.to_path_buf() } else { fs::canonicalize(p).unwrap() }
    }

    #[test]
    fn directory_target_keeps_requested_recursion() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert_eq!(
            resolve_open_target(dir, true).unwrap(),
            OpenTarget { root: canonical(dir), recursive: true, focus_file: None }
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
                root: canonical(dir),
                recursive: false,
                focus_file: Some(canonical(dir).join("a.PNG"))
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_resolves_to_its_canonical_form() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("a.png"), png(1, 1)).unwrap();
        let link = tmp.path().join("链接");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let target = resolve_open_target(&link, true).unwrap();
        assert_eq!(target.root, fs::canonicalize(&real).unwrap());
        assert_eq!(root_display_name(&link, &target), "链接");

        let by_file = resolve_open_target(&link.join("a.png"), true).unwrap();
        assert_eq!(by_file.root, target.root);
        assert_eq!(by_file.focus_file, Some(target.root.join("a.png")));
        assert_eq!(root_display_name(&link.join("a.png"), &by_file), "链接");
    }

    #[test]
    fn root_display_name_falls_back_to_the_root_path() {
        let target = OpenTarget { root: PathBuf::from("/"), recursive: false, focus_file: None };
        assert_eq!(root_display_name(Path::new("/"), &target), "/");
    }

    #[test]
    fn run_returns_what_it_registered_and_nothing_after_cancel() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("a.png"), png(4, 2)).unwrap();
        fs::write(dir.join("b.png"), png(1, 1)).unwrap();
        let registry = Registry::default();
        let target = OpenTarget { root: dir.to_path_buf(), recursive: false, focus_file: None };

        let known = run(1, &target, &registry, &AtomicBool::new(false), &|_| {});
        assert_eq!(known.len(), 2);
        let a = dir.join("a.png");
        let (id, stamp) = known[&a];
        assert_eq!(registry.path(crate::catalog::registry::FileId(id)), Some(a.clone()));
        assert_eq!(Some(stamp), crate::catalog::scan::stamp_of(&a));

        let cancel = AtomicBool::new(false);
        let known = run(2, &target, &registry, &cancel, &|_| cancel.store(true, Ordering::Relaxed));
        assert!(known.is_empty());
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
                other => panic!("打开流程不应发出 {other:?}"),
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
                other => panic!("打开流程不应发出 {other:?}"),
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
    fn run_dims_follow_exif_orientation() {
        use crate::catalog::details::testimg::{ORIENTATION, V, jpeg_with_exif, tiff};
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let t = tiff(&[(ORIENTATION, V::Short(6))], &[]);
        fs::write(dir.join("o6.jpg"), jpeg_with_exif(40, 20, &t)).unwrap();
        let events = Mutex::new(Vec::<CatalogEvent>::new());
        let target = OpenTarget { root: dir.to_path_buf(), recursive: false, focus_file: None };
        run(1, &target, &Registry::default(), &AtomicBool::new(false), &|e| {
            events.lock().unwrap().push(e)
        });
        let dims: Vec<(u32, u32)> = events
            .into_inner()
            .unwrap()
            .into_iter()
            .filter_map(|e| match e {
                CatalogEvent::Dims { items, .. } => Some(items),
                _ => None,
            })
            .flatten()
            .map(|d| (d.w, d.h))
            .collect();
        assert_eq!(dims, vec![(20, 40)]);
    }

    #[test]
    fn run_stops_after_cancel() {
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
    fn cancel_during_dims_stops_further_dims() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for i in 0..(DIMS_BATCH * 3) {
            fs::write(dir.join(format!("{i}.png")), png(1, 1)).unwrap();
        }
        let registry = Registry::default();
        let cancel = AtomicBool::new(false);
        let after_done_dims = Mutex::new(0usize);
        let done_seen = AtomicBool::new(false);
        let target = OpenTarget { root: dir.to_path_buf(), recursive: false, focus_file: None };
        run(1, &target, &registry, &cancel, &|e| match e {
            CatalogEvent::Done { .. } => {
                done_seen.store(true, Ordering::Relaxed);
                cancel.store(true, Ordering::Relaxed);
            }
            CatalogEvent::Dims { .. } if done_seen.load(Ordering::Relaxed) => {
                *after_done_dims.lock().unwrap() += 1;
            }
            _ => {}
        });
        assert_eq!(*after_done_dims.lock().unwrap(), 0);
    }

    #[test]
    fn begin_cancels_the_previous_session() {
        let s = Sessions::default();
        s.note(1);
        let (g1, c1) = s.begin(1).unwrap();
        s.note(2);
        let (g2, c2) = s.begin(2).unwrap();
        assert_eq!(g2, g1 + 1);
        assert!(c1.load(Ordering::Relaxed));
        assert!(!c2.load(Ordering::Relaxed));
    }

    #[test]
    fn codec_state_resets_on_open() {
        use glance_syscodec::Kind;
        // 进程内那一份状态别的测试也会动（其他测试里的 begin 会把它清掉），这里只断言 begin 之后的结果。
        crate::decode::mark_codec_missing(Kind::Avif);
        let s = Sessions::default();
        s.note(1);
        s.begin(1).unwrap();
        assert_eq!(crate::decode::codec_missing(Kind::Avif), None);
    }

    #[test]
    fn begin_rejects_an_older_sequence() {
        let s = Sessions::default();
        s.note(1);
        s.note(2);
        assert!(s.begin(1).is_none());
        let (g, _) = s.begin(2).unwrap();
        assert_eq!(g, 1);
    }

    #[test]
    fn rejected_begin_does_not_cancel_the_current_session() {
        let s = Sessions::default();
        s.note(5);
        let (_, cancel) = s.begin(5).unwrap();
        s.note(7);
        assert!(s.begin(6).is_none());
        assert!(!cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn current_is_none_until_attached_and_after_the_next_begin() {
        use std::sync::mpsc::channel;
        let s = Sessions::default();
        assert_eq!(s.current(), None);
        s.note(1);
        let (g1, _) = s.begin(1).unwrap();
        assert_eq!(s.current(), None, "attach 之前没有当前会话");
        let (tx, _rx) = channel();
        s.attach(g1, PathBuf::from("/r"), tx.clone());
        assert_eq!(s.current(), Some((g1, PathBuf::from("/r"))));
        s.note(2);
        let (g2, _) = s.begin(2).unwrap();
        assert_eq!(s.current(), None, "下一次 begin 清掉上一次的会话");
        s.attach(g2, PathBuf::from("/r2"), tx);
        assert_eq!(s.current(), Some((g2, PathBuf::from("/r2"))));
    }

    #[test]
    fn contains_follows_root_and_recursion() {
        use std::sync::mpsc::channel;
        let s = Sessions::default();
        let root = PathBuf::from("/r");
        assert!(!s.contains(&root.join("a.png")), "没有会话");
        s.note(1);
        let (g1, _) = s.begin(1).unwrap();
        let (tx, _rx) = channel();
        s.attach_scoped(g1, root.clone(), false, tx.clone());
        assert!(s.contains(&root.join("a.png")));
        assert!(!s.contains(&root.join("sub/a.png")), "不含子目录");
        assert!(!s.contains(&root), "根本身不算");
        assert!(!s.contains(Path::new("/other/a.png")));
        assert!(!s.contains(Path::new("/r2/a.png")));
        s.note(2);
        let (g2, _) = s.begin(2).unwrap();
        s.attach_scoped(g2, root.clone(), true, tx);
        assert!(s.contains(&root.join("sub/a.png")));
        assert!(!s.contains(&root.join(".hidden/a.png")), "跳过的目录不算");
    }

    #[test]
    fn hint_before_attach_or_after_next_begin_is_dropped() {
        use crate::catalog::reconcile::FsHint;
        use crate::catalog::watch::SessionMsg;
        use std::sync::mpsc::channel;

        let hints = || vec![FsHint::Touched(PathBuf::from("/r/a.png"))];
        let received = |rx: &std::sync::mpsc::Receiver<SessionMsg>| {
            rx.try_iter()
                .filter(|m| matches!(m, SessionMsg::Hints(h) if *h == hints()))
                .count()
        };
        let s = Sessions::default();
        assert_eq!(s.root(), None);
        s.hint(hints()); // 没有会话：什么都不做

        s.note(1);
        let (g1, _) = s.begin(1).unwrap();
        let (tx, rx) = channel();
        s.hint(hints());
        assert_eq!(received(&rx), 0, "attach 之前的提示应丢弃");

        s.attach(g1, PathBuf::from("/r"), tx.clone());
        assert_eq!(s.root(), Some(PathBuf::from("/r")));
        s.hint(hints());
        assert_eq!(received(&rx), 1);

        s.note(2);
        let (g2, _) = s.begin(2).unwrap();
        assert_eq!(s.root(), None, "下一次 begin 清掉上一次的根目录");
        s.hint(hints());
        assert_eq!(received(&rx), 0, "下一次 begin 之后不再投给旧会话");

        // 过期的 attach 被忽略
        s.attach(g1, PathBuf::from("/old"), tx.clone());
        assert_eq!(s.root(), None);
        let (tx2, rx2) = channel();
        s.attach(g2, PathBuf::from("/r2"), tx2);
        s.hint(hints());
        assert_eq!(received(&rx), 0);
        assert_eq!(received(&rx2), 1);
        assert_eq!(s.root(), Some(PathBuf::from("/r2")));
    }
}
