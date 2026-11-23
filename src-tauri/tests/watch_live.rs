//! 真实目录、真实监听的端到端测试。依赖系统的文件事件，时序不完全可控，
//! 只在显式指定 `--ignored` 时运行：
//! `cargo test -p glance --test watch_live -- --ignored`

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use glance_imaging::{RgbaView, encode_png_lossless};
use glance_lib::catalog::events::CatalogEvent;
use glance_lib::catalog::registry::Registry;
use glance_lib::catalog::session::resolve_open_target;
use glance_lib::catalog::watch::serve;

const WAIT: Duration = Duration::from_secs(5);

fn png() -> Vec<u8> {
    let data = vec![255u8; 4];
    encode_png_lossless(RgbaView {
        width: 1,
        height: 1,
        data: &data,
    })
    .unwrap()
}

/// 运行中的 serve 及前端视角的网格模型（id → 相对路径）。
struct Live {
    rx: Receiver<CatalogEvent>,
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    grid: HashMap<u32, String>,
    done: bool,
    /// 每个相对路径出现过的 id。
    ids_seen: HashMap<String, BTreeSet<u32>>,
    removed: Vec<u32>,
    renamed: Vec<(u32, String)>,
}

impl Live {
    fn start(path: &Path) -> Live {
        let target = resolve_open_target(path, true).unwrap();
        let (tx, rx) = channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(Registry::default());
        let c = cancel.clone();
        let handle = std::thread::spawn(move || {
            serve(
                1,
                target,
                registry,
                c,
                Box::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
        });
        Live {
            rx,
            cancel,
            handle,
            grid: HashMap::new(),
            done: false,
            ids_seen: HashMap::new(),
            removed: Vec::new(),
            renamed: Vec::new(),
        }
    }

    fn apply(&mut self, e: CatalogEvent) {
        match e {
            CatalogEvent::Batch {
                generation,
                entries,
            } => {
                assert_eq!(generation, 1);
                for en in entries {
                    self.ids_seen
                        .entry(en.rel_path.clone())
                        .or_default()
                        .insert(en.id);
                    self.grid.insert(en.id, en.rel_path);
                }
            }
            CatalogEvent::Done { .. } => self.done = true,
            CatalogEvent::Dims { .. } => {}
            CatalogEvent::Removed { ids, .. } => {
                for id in ids {
                    self.grid.remove(&id);
                    self.removed.push(id);
                }
            }
            CatalogEvent::Renamed { items, .. } => {
                for it in items {
                    self.ids_seen
                        .entry(it.rel_path.clone())
                        .or_default()
                        .insert(it.id);
                    self.grid.insert(it.id, it.rel_path.clone());
                    self.renamed.push((it.id, it.rel_path));
                }
            }
            CatalogEvent::WatchFailed { .. } => panic!("监听不应失败"),
        }
    }

    /// 收事件直到 cond 成立，返回耗时；超过 WAIT 则失败。
    fn until(&mut self, what: &str, cond: impl Fn(&Live) -> bool) -> Duration {
        let start = Instant::now();
        while !cond(self) {
            let left = WAIT.checked_sub(start.elapsed()).unwrap_or_default();
            match self.rx.recv_timeout(left) {
                Ok(e) => self.apply(e),
                Err(RecvTimeoutError::Timeout) => panic!("{what}：{WAIT:?} 内没有等到"),
                Err(RecvTimeoutError::Disconnected) => panic!("{what}：serve 提前退出"),
            }
        }
        let took = start.elapsed();
        println!("{what}: {took:?}");
        took
    }

    /// 再收一段时间的事件（用来确认没有多余的推送）。
    fn drain_for(&mut self, d: Duration) {
        let end = Instant::now() + d;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.rx.recv_timeout(left) {
                Ok(e) => self.apply(e),
                Err(_) => break,
            }
        }
    }

    fn id_of(&self, rel: &str) -> Option<u32> {
        self.grid
            .iter()
            .find(|(_, r)| r.as_str() == rel)
            .map(|(id, _)| *id)
    }

    fn stop(self) {
        let start = Instant::now();
        self.cancel.store(true, Ordering::Relaxed);
        while !self.handle.is_finished() {
            assert!(
                start.elapsed() < Duration::from_secs(1),
                "cancel 后 1 秒内应返回"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        self.handle.join().unwrap();
        println!("cancel → 返回: {:?}", start.elapsed());
    }
}

#[test]
#[ignore]
fn changes_during_and_after_scan_are_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("a.png"), png()).unwrap();

    let mut live = Live::start(dir);
    live.until("Done", |l| l.done);
    let a = live.id_of("a.png").expect("扫描应找到 a.png");

    fs::write(dir.join("b.png"), png()).unwrap();
    live.until("新建 b.png", |l| l.id_of("b.png").is_some());
    let b = live.id_of("b.png").unwrap();

    fs::rename(dir.join("b.png"), dir.join("c.png")).unwrap();
    live.until("b.png 改名为 c.png", |l| {
        l.id_of("b.png").is_none() && l.id_of("c.png").is_some()
    });
    if live.id_of("c.png") == Some(b) {
        println!("改名：Renamed（同一 id）");
        assert!(live.renamed.contains(&(b, "c.png".to_string())));
    } else {
        println!("改名：Removed + Batch（未配对）");
        assert!(live.removed.contains(&b));
    }

    fs::remove_file(dir.join("a.png")).unwrap();
    live.until("删除 a.png", |l| l.removed.contains(&a));
    assert_eq!(live.grid.len(), 1);

    live.stop();
}

#[test]
#[ignore]
fn events_queued_before_scan_finishes_are_not_lost() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let bytes = png();
    for i in 0..300 {
        fs::write(dir.join(format!("{i:03}.png")), &bytes).unwrap();
    }

    let mut live = Live::start(dir);
    // 不等 Done，立刻新建
    fs::write(dir.join("late.png"), &bytes).unwrap();
    live.until("Done", |l| l.done);
    live.until("late.png 出现", |l| l.id_of("late.png").is_some());
    // 去抖窗口过后再看一会儿，确认没有重复
    live.drain_for(Duration::from_secs(1));

    assert_eq!(live.grid.len(), 301);
    assert_eq!(
        live.grid
            .values()
            .filter(|r| r.as_str() == "late.png")
            .count(),
        1
    );
    assert_eq!(live.ids_seen["late.png"].len(), 1, "late.png 只应有一个 id");

    live.stop();
}

#[cfg(unix)]
#[test]
#[ignore]
fn opening_through_a_symlink_still_follows_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let mut live = Live::start(&link);
    live.until("Done", |l| l.done);
    fs::write(link.join("new.png"), png()).unwrap();
    live.until("经链接新建 new.png", |l| l.id_of("new.png").is_some());

    live.stop();
}
