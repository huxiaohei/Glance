//! 目录监听：一次打开的完整生命周期——启动监听、扫描、补尺寸，然后把去抖后的
//! 监听事件交给比对器，推送得出的变化。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

use notify_debouncer_full::notify::event::{EventKind, ModifyKind, RenameMode};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};

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

/// 把一批变化按固定顺序发出：Removed → Renamed → Batch → Dims（对 upsert_paths 读文件头）。
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
            let size = imagesize::size(path).ok()?;
            Some(Dim {
                id: *id,
                w: size.width as u32,
                h: size.height as u32,
            })
        })
        .collect();
    if !items.is_empty() {
        emit(CatalogEvent::Dims { generation, items });
    }
}

type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// 启动去抖监听；回调线程只把结果转进通道，比对在会话线程里做。
fn start_watcher(
    target: &OpenTarget,
    tx: Sender<DebounceEventResult>,
) -> notify_debouncer_full::notify::Result<Watcher> {
    let mut debouncer = new_debouncer(DEBOUNCE, None, tx)?;
    let mode = if target.recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    debouncer.watch(&target.root, mode)?;
    Ok(debouncer)
}

/// 一次打开的完整生命周期，在调用方提供的专属线程里运行直到 cancel 置位：
/// 1. 启动监听（失败则发 WatchFailed，后面照常扫描）；事件先进通道排队
/// 2. session::run（扫描、Done、补尺寸）
/// 3. 循环：从通道取事件（每 200 ms 检查一次 cancel）→ hints_from → Reconciler::apply → emit_changes
///
/// 监听器本身报错（Err 批次）时发一次 WatchFailed 并继续，同时整棵重扫一次，
/// 补上可能丢掉的事件。cancel 后丢弃监听器并返回；监听没能启动时扫描完即返回。
/// 所有事件发出前检查 cancel。
pub fn serve(
    generation: u32,
    target: OpenTarget,
    registry: Arc<Registry>,
    cancel: Arc<AtomicBool>,
    emit: Box<dyn Fn(CatalogEvent) + Send + Sync>,
) {
    let send = |event: CatalogEvent| {
        if !cancel.load(Ordering::Relaxed) {
            emit(event);
        }
    };

    let (tx, rx) = channel();
    let watcher = start_watcher(&target, tx);
    let mut watch_failed = watcher.is_err();
    if watch_failed {
        send(CatalogEvent::WatchFailed { generation });
    }

    let known = session::run(generation, &target, &registry, &cancel, &*emit);
    let mut reconciler = Reconciler::new(target.root.clone(), target.recursive, known, cancel.clone());

    while !cancel.load(Ordering::Relaxed) {
        let Some(results) = next_results(&rx) else {
            // 通道断开：监听没能启动，或去抖线程意外退出，之后不会再有事件
            if !watch_failed {
                send(CatalogEvent::WatchFailed { generation });
            }
            return;
        };
        let mut hints = Vec::new();
        for result in results {
            match result {
                Ok(events) => hints.extend(hints_from(&target.root, &events)),
                Err(_) => {
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
        emit_changes(generation, changes, &send);
    }
    drop(watcher);
}

/// 等至多 CANCEL_POLL 取一个结果，再顺带取走已排队的，合成一批处理。
/// 超时返回空表；通道已断开（监听没能启动）返回 None。
fn next_results(rx: &Receiver<DebounceEventResult>) -> Option<Vec<DebounceEventResult>> {
    match rx.recv_timeout(CANCEL_POLL) {
        Ok(first) => {
            let mut results = vec![first];
            results.extend(rx.try_iter());
            Some(results)
        }
        Err(RecvTimeoutError::Timeout) => Some(Vec::new()),
        Err(RecvTimeoutError::Disconnected) => None,
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
}
