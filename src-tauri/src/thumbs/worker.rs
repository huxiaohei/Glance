//! 工作线程与调度。

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex};

use super::Tier;
use super::cache::ThumbCache;
use super::queue::{Job, WantQueue};
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::scan::stamp_of;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThumbEvent {
    Ready { id: u32, tier: u32, v: String },
    Broken { id: u32 },
}

/// 读文件期间文件被改写时，最多尝试这么多次。
const ATTEMPTS: usize = 3;

/// 处理一个任务：已缓存直接 Ready；否则读文件、生成、写缓存。
/// 文件未登记、已不存在、读失败或解码失败 → Broken。绝不 panic。
pub fn process(job: Job, registry: &Registry, cache: &ThumbCache) -> ThumbEvent {
    process_with(job, registry, cache, &mut |_| {})
}

/// after_read 在读完、解码完之后调用，测试借此在两次查看文件状态之间改写文件。
///
/// 缓存键与版本号出自读文件前查看的同一份文件状态；读完、解码完再查看一次，
/// 状态变了说明读到的可能是改写到一半或已过时的字节：丢弃结果重来（解码失败也一样，
/// 可能正是因为读到了一半），最多 ATTEMPTS 次，仍在变则 Broken。
/// 状态只比较大小与毫秒级修改时间，同一毫秒内大小不变的改写分辨不出。
fn process_with(
    job: Job,
    registry: &Registry,
    cache: &ThumbCache,
    after_read: &mut dyn FnMut(&std::path::Path),
) -> ThumbEvent {
    let (id, tier) = job;
    let broken = ThumbEvent::Broken { id: id.0 };
    let Some(path) = registry.path(id) else {
        return broken;
    };
    for _ in 0..ATTEMPTS {
        let Some(stamp) = stamp_of(&path) else {
            return broken;
        };
        let key = ThumbCache::key_for_stamp(&path, stamp, tier);
        let ready = ThumbEvent::Ready {
            id: id.0,
            tier: tier.px(),
            v: stamp.version(),
        };
        if cache.contains(&key) {
            return ready;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return broken;
        };
        // 解码库万一 panic，也只算这张图损坏，不能带走工作线程。
        let made = catch_unwind(AssertUnwindSafe(|| {
            glance_imaging::make_thumbnail(&bytes, tier.px())
        }));
        after_read(&path);
        if stamp_of(&path) != Some(stamp) {
            continue;
        }
        return match made {
            Ok(Ok(thumb)) if cache.put(&key, &thumb.webp).is_ok() => ready,
            _ => broken,
        };
    }
    broken
}

type Sink = Arc<dyn Fn(ThumbEvent) + Send + Sync>;

struct Shared {
    queue: Mutex<WantQueue>,
    wake: Condvar,
    sink: Mutex<Option<Sink>>,
    cache: ThumbCache,
    registry: Arc<Registry>,
}

pub struct Thumbs {
    shared: Arc<Shared>,
}

fn worker_loop(shared: Arc<Shared>) {
    loop {
        let job = {
            let mut queue = shared.queue.lock().unwrap();
            loop {
                if let Some(job) = queue.pop() {
                    break job;
                }
                queue = shared.wake.wait(queue).unwrap();
            }
        };
        // 队列锁已释放：生成缩略图期间不阻塞 want。
        let event = process(job, &shared.registry, &shared.cache);
        let sink = shared.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }
}

impl Thumbs {
    /// 启动 max(1, CPU 数 − 2) 个工作线程。线程随应用存活，不回收。
    pub fn start(cache: ThumbCache, registry: Arc<Registry>) -> Arc<Thumbs> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(WantQueue::default()),
            wake: Condvar::new(),
            sink: Mutex::new(None),
            cache,
            registry,
        });
        let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
        for n in 0..cpus.saturating_sub(2).max(1) {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name(format!("thumb-worker-{n}"))
                .spawn(move || worker_loop(shared))
                .expect("spawn thumbnail worker");
        }
        Arc::new(Thumbs { shared })
    }

    pub fn cache(&self) -> &ThumbCache {
        &self.shared.cache
    }

    /// 替换上一个订阅者。
    pub fn subscribe(&self, sink: Box<dyn Fn(ThumbEvent) + Send + Sync>) {
        *self.shared.sink.lock().unwrap() = Some(Arc::from(sink));
    }

    /// 返回其中已有缓存的 (ID, 版本号)；其余进入队列。
    pub fn want(&self, consumer: &str, ids: &[FileId], tier: Tier) -> Vec<(FileId, String)> {
        // 磁盘检查在队列锁之外进行。
        let mut cached = Vec::new();
        let mut jobs = Vec::new();
        for &id in ids {
            let hit = self.shared.registry.path(id).and_then(|p| {
                let stamp = stamp_of(&p)?;
                let key = ThumbCache::key_for_stamp(&p, stamp, tier);
                self.shared.cache.contains(&key).then(|| stamp.version())
            });
            if let Some(v) = hit {
                cached.push((id, v));
            } else {
                jobs.push((id, tier));
            }
        }
        self.shared.queue.lock().unwrap().set(consumer, jobs);
        self.shared.wake.notify_all();
        cached
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::{FileId, Registry};
    use crate::catalog::scan::stamp_of;
    use crate::thumbs::Tier;
    use crate::thumbs::cache::ThumbCache;
    use glance_imaging::{RgbaView, encode_png_lossless};
    use std::path::Path;
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    fn write_png(path: &Path) {
        let (w, h) = (400u32, 200u32);
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % 251) as u8, 80, 160, 255])
            .collect();
        let png = encode_png_lossless(RgbaView {
            width: w,
            height: h,
            data: &data,
        })
        .unwrap();
        std::fs::write(path, png).unwrap();
    }

    fn file_count(dir: &Path) -> usize {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .count()
    }

    #[test]
    fn thumb_events_serialize_to_the_agreed_shape() {
        assert_eq!(
            serde_json::to_string(&ThumbEvent::Ready {
                id: 1,
                tier: 320,
                v: "7-9".into()
            })
            .unwrap(),
            r#"{"type":"ready","id":1,"tier":320,"v":"7-9"}"#
        );
        assert_eq!(
            serde_json::to_string(&ThumbEvent::Broken { id: 1 }).unwrap(),
            r#"{"type":"broken","id":1}"#
        );
    }

    #[test]
    fn ready_carries_the_stamp_the_thumbnail_was_made_from() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        write_png(&img);
        let registry = Registry::default();
        let id = registry.register(&img);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let v = stamp_of(&img).unwrap().version();
        assert_eq!(
            process((id, Tier::S), &registry, &cache),
            ThumbEvent::Ready {
                id: id.0,
                tier: 320,
                v
            }
        );
    }

    #[test]
    fn rewritten_file_yields_a_new_version() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        write_png(&img);
        let registry = Registry::default();
        let id = registry.register(&img);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let version = |e: ThumbEvent| match e {
            ThumbEvent::Ready { v, .. } => v,
            other => panic!("expected ready, got {other:?}"),
        };
        let first = version(process((id, Tier::S), &registry, &cache));
        let bigger = {
            let (w, h) = (500u32, 300u32);
            let data: Vec<u8> = (0..w * h)
                .flat_map(|i| [(i % 7) as u8, 1, 2, 255])
                .collect();
            encode_png_lossless(RgbaView {
                width: w,
                height: h,
                data: &data,
            })
            .unwrap()
        };
        std::fs::write(&img, bigger).unwrap();
        let second = version(process((id, Tier::S), &registry, &cache));
        assert_ne!(first, second);
    }

    #[test]
    fn process_generates_caches_and_reports_ready() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        write_png(&img);
        let registry = Registry::default();
        let id = registry.register(&img);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let expect = ThumbEvent::Ready {
            id: id.0,
            tier: 320,
            v: stamp_of(&img).unwrap().version(),
        };
        assert_eq!(process((id, Tier::S), &registry, &cache), expect);
        let key = ThumbCache::key_for_file(&img, Tier::S).unwrap();
        let bytes = cache.get(&key).unwrap();
        let size = imagesize::blob_size(&bytes).unwrap();
        assert_eq!((size.width, size.height), (320, 160));
        assert_eq!(process((id, Tier::S), &registry, &cache), expect);
    }

    /// 纯色 PNG 后面再接 pad 个字节（解码器忽略 IEND 之后的内容）。纯色图压缩后大小
    /// 往往相同，同一毫秒内改写时修改时间也不变；靠 pad 保证每次改写文件大小都不同。
    fn png_of_width(w: u32, pad: usize) -> Vec<u8> {
        let data = vec![200u8; (w * 10 * 4) as usize];
        let mut bytes = encode_png_lossless(RgbaView {
            width: w,
            height: 10,
            data: &data,
        })
        .unwrap();
        bytes.extend(std::iter::repeat_n(0u8, pad));
        bytes
    }

    #[test]
    fn trailing_bytes_after_png_still_decode() {
        let t = glance_imaging::make_thumbnail(&png_of_width(40, 7), 320).unwrap();
        let size = imagesize::blob_size(&t.webp).unwrap();
        assert_eq!((size.width, size.height), (40, 10));
    }

    #[test]
    fn file_rewritten_while_reading_is_retried_with_the_new_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        std::fs::write(&img, png_of_width(40, 0)).unwrap();
        let registry = Registry::default();
        let id = registry.register(&img);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let mut calls = 0;
        // 第一次读完之后文件被改写（多接 1 字节，大小必然不同，版本也就不同）
        let event = process_with((id, Tier::S), &registry, &cache, &mut |p| {
            calls += 1;
            if calls == 1 {
                std::fs::write(p, png_of_width(90, 1)).unwrap();
            }
        });
        assert_eq!(calls, 2);
        let v = stamp_of(&img).unwrap().version();
        assert_eq!(
            event,
            ThumbEvent::Ready {
                id: id.0,
                tier: 320,
                v
            }
        );
        // 缓存的是新内容的缩略图，旧内容的没有写入
        let key = ThumbCache::key_for_file(&img, Tier::S).unwrap();
        let size = imagesize::blob_size(&cache.get(&key).unwrap()).unwrap();
        assert_eq!((size.width, size.height), (90, 10));
        assert_eq!(file_count(cache_dir.path()), 1);
    }

    #[test]
    fn file_that_keeps_changing_is_broken_after_bounded_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        std::fs::write(&img, png_of_width(10, 0)).unwrap();
        let registry = Registry::default();
        let id = registry.register(&img);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let mut calls = 0u32;
        let event = process_with((id, Tier::S), &registry, &cache, &mut |p| {
            calls += 1;
            // 每次多接一个字节：大小每次都不同，同一毫秒内的改写也分辨得出
            std::fs::write(p, png_of_width(10, calls as usize)).unwrap();
        });
        assert_eq!(event, ThumbEvent::Broken { id: id.0 });
        assert_eq!(calls, ATTEMPTS as u32);
        assert_eq!(file_count(cache_dir.path()), 0);
    }

    #[test]
    fn process_reports_broken_for_every_failure_mode() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());

        let unregistered = FileId(999);
        let gone = dir.path().join("gone.png");
        write_png(&gone);
        let gone_id = registry.register(&gone);
        std::fs::remove_file(&gone).unwrap();
        let empty = dir.path().join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        let empty_id = registry.register(&empty);
        let junk = dir.path().join("junk.png");
        std::fs::write(&junk, b"x").unwrap();
        let junk_id = registry.register(&junk);

        for id in [unregistered, gone_id, empty_id, junk_id] {
            assert_eq!(
                process((id, Tier::S), &registry, &cache),
                ThumbEvent::Broken { id: id.0 }
            );
        }
        assert_eq!(file_count(cache_dir.path()), 0);
    }

    #[test]
    fn want_returns_cached_ids_and_delivers_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(Registry::default());
        let ids: Vec<FileId> = ["a", "b", "c"]
            .iter()
            .map(|n| {
                let p = dir.path().join(format!("{n}.png"));
                write_png(&p);
                registry.register(&p)
            })
            .collect();
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        assert!(matches!(
            process((a, Tier::S), &registry, &cache),
            ThumbEvent::Ready { .. }
        ));
        let thumbs = Thumbs::start(cache, registry.clone());
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        thumbs.subscribe(Box::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        }));
        let va = stamp_of(&registry.path(a).unwrap()).unwrap().version();
        assert_eq!(thumbs.want("grid", &[a, b, c], Tier::S), vec![(a, va)]);
        let mut got = Vec::new();
        for _ in 0..2 {
            got.push(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        let ready = |id: FileId| ThumbEvent::Ready {
            id: id.0,
            tier: 320,
            v: stamp_of(&registry.path(id).unwrap()).unwrap().version(),
        };
        assert!(got.contains(&ready(b)) && got.contains(&ready(c)));
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }
}
