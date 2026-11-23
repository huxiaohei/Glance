//! 目录监听：一次打开的完整生命周期——启动监听、扫描、补尺寸，然后把去抖后的
//! 监听事件与外部投递的路径提示交给比对器，推送得出的变化。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use notify_debouncer_full::notify::event::{EventKind, ModifyKind, RenameMode};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};

use super::details::display_size;
use super::events::{CatalogEvent, Dim};
use super::reconcile::{Changes, FsHint, Reconciler};
use super::registry::Registry;
use super::session::{self, OpenTarget};

pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// 会话线程多久检查一次 cancel。
const CANCEL_POLL: Duration = Duration::from_millis(200);

/// 把去抖后的事件翻译成提示：改名且新旧路径齐全（RenameMode::Both）→ Renamed；
/// 其余每个路径一条 Touched（同一路径只留第一条）；Access 类事件丢弃。
/// 带 Rescan 标志的事件（系统丢了事件，或要求重新核对）→ Touched(root)，整棵重扫。
/// 改名的两半没能配对时（FSEvents 上常见，只改大小写的改名也是这样），各自成为
/// Touched，由比对器查看磁盘判断。
///
/// 新建事件与没能配对的改名事件另给父目录一条 Listed（每个目录一条，排在最后）：
/// FSEvents 会把刚新建的文件在约一秒内又被改名报告成“新建 + 改名”，去抖器据此把
/// 整件事合并成目标处的一次新建，源的消失被吞掉；改名也可能只报了一半。列一次父目录
/// 把它补回来。
pub fn hints_from(root: &Path, events: &[DebouncedEvent]) -> Vec<FsHint> {
    let mut hints = Vec::new();
    let mut listed: Vec<PathBuf> = Vec::new();
    let mut touched: HashSet<PathBuf> = HashSet::new();
    let mut touch = |hints: &mut Vec<FsHint>, p: &Path| {
        if touched.insert(p.to_path_buf()) {
            hints.push(FsHint::Touched(p.to_path_buf()));
        }
    };
    for e in events {
        if e.need_rescan() {
            touch(&mut hints, root);
            continue;
        }
        match e.kind {
            EventKind::Access(_) => {}
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if e.paths.len() == 2 => {
                hints.push(FsHint::Renamed {
                    from: e.paths[0].clone(),
                    to: e.paths[1].clone(),
                });
            }
            kind => {
                // 新建，或没能配对的改名半边：父目录各列一次
                let list_parent = matches!(
                    kind,
                    EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
                );
                for p in &e.paths {
                    touch(&mut hints, p);
                    if list_parent
                        && let Some(parent) = p.parent()
                        && parent.starts_with(root)
                        && !listed.iter().any(|d| d == parent)
                    {
                        listed.push(parent.to_path_buf());
                    }
                }
            }
        }
    }
    hints.extend(listed.into_iter().map(FsHint::Listed));
    hints
}

/// 把一批变化按固定顺序发出：Removed → Renamed → Batch → Dims（对 upsert_paths 读文件头，
/// 取按 EXIF 方向转正后的显示尺寸）。
/// 空的部分不发；读不出尺寸的文件不出现在 Dims 里。
pub fn emit_changes(generation: u32, changes: Changes, emit: &dyn Fn(CatalogEvent)) {
    let Changes {
        removed,
        renamed,
        upserts,
        upsert_paths,
    } = changes;
    if !removed.is_empty() {
        emit(CatalogEvent::Removed {
            generation,
            ids: removed,
        });
    }
    if !renamed.is_empty() {
        emit(CatalogEvent::Renamed {
            generation,
            items: renamed,
        });
    }
    if !upserts.is_empty() {
        emit(CatalogEvent::Batch {
            generation,
            entries: upserts,
        });
    }
    let items: Vec<Dim> = upsert_paths
        .iter()
        .filter_map(|(id, path)| {
            let (w, h) = display_size(path)?;
            Some(Dim { id: *id, w, h })
        })
        .collect();
    if !items.is_empty() {
        emit(CatalogEvent::Dims { generation, items });
    }
}

type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// 会话线程收件口里的消息：监听器的去抖结果，或外部（文件操作之后）投递的路径提示。
pub enum SessionMsg {
    Watch(DebounceEventResult),
    Hints(Vec<FsHint>),
}

/// 启动去抖监听；回调线程只把结果包成 [`SessionMsg::Watch`] 转进通道，比对在会话线程里做。
fn start_watcher(
    target: &OpenTarget,
    tx: Sender<SessionMsg>,
) -> notify_debouncer_full::notify::Result<Watcher> {
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |result| {
        // 会话线程已退出时发送失败，不是错误
        let _ = tx.send(SessionMsg::Watch(result));
    })?;
    let mode = if target.recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    debouncer.watch(&target.root, mode)?;
    Ok(debouncer)
}

/// 一次打开的完整生命周期，在调用方提供的专属线程里运行直到 cancel 置位：
/// 1. 启动监听（失败则发 WatchFailed，后面照常扫描）；监听事件先进收件口排队
/// 2. session::run（扫描、Done、补尺寸）
/// 3. 循环：从收件口取消息（每 200 ms 检查一次 cancel），监听结果经 hints_from 与外部投递的
///    提示合成一批 → Reconciler::apply → emit_changes
///
/// 收件口由调用方创建（`inbox` 的发送端另有一份交给 `Sessions`，供文件操作投递提示）。
/// 监听器本身报错（Err 批次）时发一次 WatchFailed 并继续，同时整棵重扫一次，
/// 补上可能丢掉的事件。监听没能启动时照样等外部提示，直到 cancel；cancel 后丢弃监听器并返回。
/// 某批让条目消失、且根目录已不存在时，在这批事件之后发 RootGone（每个会话一次）。
/// 所有事件发出前检查 cancel。
pub fn serve(
    generation: u32,
    target: OpenTarget,
    registry: Arc<Registry>,
    cancel: Arc<AtomicBool>,
    inbox: (Sender<SessionMsg>, Receiver<SessionMsg>),
    emit: Box<dyn Fn(CatalogEvent) + Send + Sync>,
) {
    let send = |event: CatalogEvent| {
        if !cancel.load(Ordering::Relaxed) {
            emit(event);
        }
    };

    // 自己留着一份发送端：通道在会话期间不会断开，会话只因 cancel 结束
    let (tx, rx) = inbox;
    let watcher = start_watcher(&target, tx.clone());
    let mut watch_failed = watcher.is_err();
    if watch_failed {
        send(CatalogEvent::WatchFailed { generation });
    }

    let known = session::run(generation, &target, &registry, &cancel, &*emit);
    let mut reconciler = Reconciler::new(target.root.clone(), target.recursive, known, cancel.clone());
    let mut root_gone = false;

    while !cancel.load(Ordering::Relaxed) {
        let mut hints = Vec::new();
        for msg in next_messages(&rx) {
            match msg {
                SessionMsg::Hints(h) => hints.extend(h),
                SessionMsg::Watch(Ok(events)) => hints.extend(hints_from(&target.root, &events)),
                SessionMsg::Watch(Err(_)) => {
                    if !watch_failed {
                        watch_failed = true;
                        send(CatalogEvent::WatchFailed { generation });
                    }
                    hints.push(FsHint::Touched(target.root.clone()));
                }
            }
        }
        if hints.is_empty() || cancel.load(Ordering::Relaxed) {
            continue;
        }
        let changes = reconciler.apply(&hints, &registry);
        // 比对途中取消：结果可能不完整（子树扫描提前结束），不发
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let removed_any = !changes.removed.is_empty();
        emit_changes(generation, changes, &send);
        if removed_any && !root_gone && !target.root.exists() {
            root_gone = true;
            send(CatalogEvent::RootGone { generation });
        }
    }
    drop(watcher);
}

/// 等至多 CANCEL_POLL 取一条消息，再顺带取走已排队的，合成一批处理；超时返回空表。
/// serve 自己持有一份发送端，通道不会断开；万一断开也按超时处理（之后只等 cancel）。
fn next_messages(rx: &Receiver<SessionMsg>) -> Vec<SessionMsg> {
    match rx.recv_timeout(CANCEL_POLL) {
        Ok(first) => {
            let mut msgs = vec![first];
            msgs.extend(rx.try_iter());
            msgs
        }
        Err(RecvTimeoutError::Timeout) => Vec::new(),
        Err(RecvTimeoutError::Disconnected) => {
            std::thread::sleep(CANCEL_POLL);
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::events::{Entry, RenamedItem};
    use glance_imaging::{RgbaView, encode_png_lossless};
    use notify_debouncer_full::notify::event::{
        AccessKind, CreateKind, DataChange, Event, EventKind, Flag, ModifyKind, RemoveKind,
        RenameMode,
    };
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::mpsc::channel;
    use std::time::Instant;

    const ROOT: &str = "/r";

    fn ev(kind: EventKind, paths: &[&str]) -> DebouncedEvent {
        let mut event = Event::new(kind);
        for p in paths {
            event = event.add_path(PathBuf::from(p));
        }
        DebouncedEvent::new(event, Instant::now())
    }

    fn touched(p: &str) -> FsHint {
        FsHint::Touched(PathBuf::from(p))
    }

    #[test]
    fn rename_with_both_paths_becomes_a_rename_hint() {
        let hints = hints_from(
            Path::new(ROOT),
            &[ev(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &["/r/a.png", "/r/b.png"],
            )],
        );
        assert_eq!(
            hints,
            vec![FsHint::Renamed {
                from: PathBuf::from("/r/a.png"),
                to: PathBuf::from("/r/b.png")
            }]
        );
    }

    #[test]
    fn unpaired_rename_halves_become_touched_hints_and_list_the_parent() {
        let hints = hints_from(
            Path::new(ROOT),
            &[
                ev(
                    EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                    &["/r/a.png"],
                ),
                ev(
                    EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                    &["/r/b.png"],
                ),
                ev(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &["/r/sub/c.png"],
                ),
            ],
        );
        assert_eq!(
            hints,
            vec![
                touched("/r/a.png"),
                touched("/r/b.png"),
                touched("/r/sub/c.png"),
                FsHint::Listed(PathBuf::from(ROOT)),
                FsHint::Listed(PathBuf::from("/r/sub")),
            ]
        );
    }

    #[test]
    fn create_modify_remove_become_touched_hints() {
        let hints = hints_from(
            Path::new(ROOT),
            &[
                ev(EventKind::Create(CreateKind::File), &["/r/a.png"]),
                ev(
                    EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                    &["/r/b.png"],
                ),
                ev(
                    EventKind::Remove(RemoveKind::Any),
                    &["/r/c.png", "/r/d.png"],
                ),
                // 同一路径重复出现只留一条
                ev(EventKind::Modify(ModifyKind::Any), &["/r/a.png"]),
            ],
        );
        assert_eq!(
            hints,
            vec![
                touched("/r/a.png"),
                touched("/r/b.png"),
                touched("/r/c.png"),
                touched("/r/d.png"),
                FsHint::Listed(PathBuf::from(ROOT)),
            ]
        );
    }

    #[test]
    fn creations_also_list_their_parent_directory_once() {
        let hints = hints_from(
            Path::new(ROOT),
            &[
                ev(EventKind::Create(CreateKind::File), &["/r/sub/a.png"]),
                ev(EventKind::Create(CreateKind::File), &["/r/sub/b.png"]),
                // 根目录自身的新建：父目录在根之外，不列
                ev(EventKind::Create(CreateKind::Folder), &[ROOT]),
            ],
        );
        assert_eq!(
            hints,
            vec![
                touched("/r/sub/a.png"),
                touched("/r/sub/b.png"),
                touched(ROOT),
                FsHint::Listed(PathBuf::from("/r/sub")),
            ]
        );
    }

    #[test]
    fn access_events_are_dropped() {
        let hints = hints_from(
            Path::new(ROOT),
            &[ev(EventKind::Access(AccessKind::Any), &["/r/a.png"])],
        );
        assert!(hints.is_empty());
    }

    #[test]
    fn rescan_flag_becomes_a_touched_root() {
        let mut rescan = ev(EventKind::Other, &[]);
        rescan.event = rescan.event.clone().set_flag(Flag::Rescan);
        let hints = hints_from(
            Path::new(ROOT),
            &[
                ev(EventKind::Create(CreateKind::File), &["/r/a.png"]),
                rescan,
            ],
        );
        assert_eq!(
            hints,
            vec![
                touched("/r/a.png"),
                touched(ROOT),
                FsHint::Listed(PathBuf::from(ROOT))
            ]
        );
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let data = vec![255u8; (w * h * 4) as usize];
        encode_png_lossless(RgbaView {
            width: w,
            height: h,
            data: &data,
        })
        .unwrap()
    }

    #[test]
    fn emits_in_fixed_order_and_skips_empty_parts() {
        let tmp = tempfile::tempdir().unwrap();
        let img = tmp.path().join("new.png");
        std::fs::write(&img, png(3, 2)).unwrap();
        let broken = tmp.path().join("broken.png");
        std::fs::write(&broken, "x").unwrap();

        let changes = Changes {
            removed: vec![1],
            renamed: vec![RenamedItem {
                id: 2,
                rel_path: "b2.png".into(),
            }],
            upserts: vec![
                Entry {
                    id: 3,
                    rel_path: "new.png".into(),
                    size: 1,
                    mtime_ms: 1,
                },
                Entry {
                    id: 4,
                    rel_path: "broken.png".into(),
                    size: 1,
                    mtime_ms: 1,
                },
            ],
            upsert_paths: vec![(3, img), (4, broken)],
        };
        let events = RefCell::new(Vec::new());
        emit_changes(5, changes, &|e| events.borrow_mut().push(e));
        let events = events.into_inner();
        assert_eq!(events.len(), 4);
        assert_eq!(
            events[0],
            CatalogEvent::Removed {
                generation: 5,
                ids: vec![1]
            }
        );
        assert_eq!(
            events[1],
            CatalogEvent::Renamed {
                generation: 5,
                items: vec![RenamedItem {
                    id: 2,
                    rel_path: "b2.png".into()
                }]
            }
        );
        assert!(
            matches!(&events[2], CatalogEvent::Batch { generation: 5, entries } if entries.len() == 2)
        );
        assert_eq!(
            events[3],
            CatalogEvent::Dims {
                generation: 5,
                items: vec![crate::catalog::events::Dim { id: 3, w: 3, h: 2 }]
            }
        );

        let none = RefCell::new(Vec::new());
        emit_changes(5, Changes::default(), &|e| none.borrow_mut().push(e));
        assert!(none.into_inner().is_empty());

        // 只有改名：只发 Renamed
        let only = RefCell::new(Vec::new());
        emit_changes(
            6,
            Changes {
                renamed: vec![RenamedItem {
                    id: 2,
                    rel_path: "c.png".into(),
                }],
                ..Changes::default()
            },
            &|e| only.borrow_mut().push(e),
        );
        assert_eq!(
            only.into_inner(),
            vec![CatalogEvent::Renamed {
                generation: 6,
                items: vec![RenamedItem {
                    id: 2,
                    rel_path: "c.png".into()
                }]
            }]
        );
    }

    /// 在专属线程里运行的 serve；测试经 inbox 直接投递提示。
    struct Running {
        events: Receiver<CatalogEvent>,
        inbox: Sender<SessionMsg>,
        cancel: Arc<AtomicBool>,
        handle: std::thread::JoinHandle<()>,
    }

    const WAIT: Duration = Duration::from_secs(5);

    impl Running {
        fn start(root: PathBuf) -> Running {
            let target = OpenTarget { root, recursive: true, focus_file: None };
            let (etx, events) = channel();
            let inbox = channel();
            let tx = inbox.0.clone();
            let cancel = Arc::new(AtomicBool::new(false));
            let c = cancel.clone();
            let handle = std::thread::spawn(move || {
                serve(
                    1,
                    target,
                    Arc::new(Registry::default()),
                    c,
                    inbox,
                    Box::new(move |e| {
                        let _ = etx.send(e);
                    }),
                )
            });
            Running { events, inbox: tx, cancel, handle }
        }

        fn hint(&self, hints: Vec<FsHint>) {
            self.inbox.send(SessionMsg::Hints(hints)).unwrap();
        }

        /// 收事件直到 pick 认出一条，返回它与之前收到的全部事件。
        fn until<T>(&self, what: &str, pick: impl Fn(&CatalogEvent) -> Option<T>) -> (T, Vec<CatalogEvent>) {
            let mut seen = Vec::new();
            loop {
                let e = self
                    .events
                    .recv_timeout(WAIT)
                    .unwrap_or_else(|_| panic!("{what}：没有等到，已收到 {seen:?}"));
                if let Some(t) = pick(&e) {
                    return (t, seen);
                }
                seen.push(e);
            }
        }

        /// 再收一段时间的事件。
        fn drain_for(&self, d: Duration) -> Vec<CatalogEvent> {
            let end = Instant::now() + d;
            let mut out = Vec::new();
            while let Some(left) = end.checked_duration_since(Instant::now()) {
                match self.events.recv_timeout(left) {
                    Ok(e) => out.push(e),
                    Err(_) => break,
                }
            }
            out
        }

        fn stop(self) {
            self.cancel.store(true, Ordering::Relaxed);
            let start = Instant::now();
            while !self.handle.is_finished() {
                assert!(start.elapsed() < Duration::from_secs(2), "cancel 后应退出");
                std::thread::sleep(Duration::from_millis(10));
            }
            self.handle.join().unwrap();
        }
    }

    fn ids_of(entries: &[Entry]) -> Vec<u32> {
        entries.iter().map(|e| e.id).collect()
    }

    fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        (tmp, root)
    }

    #[test]
    fn hints_sent_to_the_session_are_reconciled() {
        let (_tmp, root) = canonical_tempdir();
        std::fs::write(root.join("a.png"), png(1, 1)).unwrap();
        std::fs::write(root.join("b.png"), png(1, 1)).unwrap();
        let run = Running::start(root.clone());
        let (_, before) = run.until("Done", |e| matches!(e, CatalogEvent::Done { .. }).then_some(()));
        let a = before
            .iter()
            .filter_map(|e| match e {
                CatalogEvent::Batch { entries, .. } => entries.iter().find(|en| en.rel_path == "a.png"),
                _ => None,
            })
            .map(|en| en.id)
            .next()
            .expect("扫描应找到 a.png");

        std::fs::remove_file(root.join("a.png")).unwrap();
        run.hint(vec![FsHint::Touched(root.join("a.png"))]);
        let (ids, _) = run.until("Removed", |e| match e {
            CatalogEvent::Removed { generation: 1, ids } => Some(ids.clone()),
            _ => None,
        });
        assert_eq!(ids, vec![a]);
        run.stop();
    }

    #[test]
    fn session_without_a_watcher_still_serves_hints() {
        // 替身：打开时根目录还不存在，监听启动失败；之后目录出现，靠提示跟上
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap().join("later");
        let run = Running::start(root.clone());
        run.until("WatchFailed", |e| matches!(e, CatalogEvent::WatchFailed { generation: 1 }).then_some(()));
        run.until("Done", |e| matches!(e, CatalogEvent::Done { total: 0, .. }).then_some(()));

        // 监听没能启动不再让会话线程退出
        std::thread::sleep(CANCEL_POLL * 2);
        assert!(!run.handle.is_finished());

        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.png"), png(1, 1)).unwrap();
        run.hint(vec![FsHint::Touched(root.join("a.png"))]);
        let (entries, _) = run.until("Batch", |e| match e {
            CatalogEvent::Batch { generation: 1, entries } => Some(entries.clone()),
            _ => None,
        });
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "a.png");
        run.stop();
    }

    #[test]
    fn root_gone_is_reported_once() {
        let (_tmp, root) = canonical_tempdir();
        std::fs::write(root.join("a.png"), png(1, 1)).unwrap();
        let run = Running::start(root.clone());
        let (_, before) = run.until("Done", |e| matches!(e, CatalogEvent::Done { .. }).then_some(()));
        let scanned: Vec<u32> = before
            .iter()
            .filter_map(|e| match e {
                CatalogEvent::Batch { entries, .. } => Some(ids_of(entries)),
                _ => None,
            })
            .flatten()
            .collect();

        std::fs::remove_dir_all(&root).unwrap();
        run.hint(vec![FsHint::Touched(root.clone())]);
        let (_, earlier) = run.until("RootGone", |e| {
            matches!(e, CatalogEvent::RootGone { generation: 1 }).then_some(())
        });
        let removed: Vec<u32> = earlier
            .iter()
            .filter_map(|e| match e {
                CatalogEvent::Removed { ids, .. } => Some(ids.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(removed, scanned, "RootGone 排在这批的 Removed 之后");

        run.hint(vec![FsHint::Touched(root.clone())]);
        let later = run.drain_for(Duration::from_millis(600));
        assert!(!later.iter().any(|e| matches!(e, CatalogEvent::RootGone { .. })), "{later:?}");

        // 目录回来又再次消失：每个会话只报一次
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("b.png"), png(1, 1)).unwrap();
        run.hint(vec![FsHint::Touched(root.join("b.png"))]);
        run.until("b.png", |e| matches!(e, CatalogEvent::Batch { .. }).then_some(()));
        std::fs::remove_dir_all(&root).unwrap();
        run.hint(vec![FsHint::Touched(root.clone())]);
        run.until("Removed", |e| matches!(e, CatalogEvent::Removed { .. }).then_some(()));
        let later = run.drain_for(Duration::from_millis(600));
        assert!(!later.iter().any(|e| matches!(e, CatalogEvent::RootGone { .. })), "{later:?}");
        run.stop();
    }
}
