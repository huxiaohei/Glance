//! 万张目录验收：测扫描与补尺寸耗时。需要先用 gen-fixtures 生成 `fixtures/many10k`。
//! 只在显式指定 `--ignored` 时运行。

use glance_lib::catalog::events::CatalogEvent;
use glance_lib::catalog::registry::Registry;
use glance_lib::catalog::session::{OpenTarget, run};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Default)]
struct Stats {
    first_batch_ms: Option<u128>,
    done_ms: Option<u128>,
    last_dims_ms: Option<u128>,
    entries: usize,
    dims: usize,
    done_total: Option<usize>,
}

#[test]
#[ignore]
fn scan_10k() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/many10k");
    if !root.exists() {
        println!("跳过：{} 不存在，先运行 gen-fixtures 生成样张", root.display());
        return;
    }
    let target = OpenTarget {
        root,
        recursive: true,
        focus_file: None,
    };
    let registry = Registry::default();
    let cancel = AtomicBool::new(false);
    let stats = Mutex::new(Stats::default());
    let start = Instant::now();

    run(1, &target, &registry, &cancel, &|event| {
        let ms = start.elapsed().as_millis();
        let mut s = stats.lock().unwrap();
        match event {
            CatalogEvent::Batch { entries, .. } => {
                s.first_batch_ms.get_or_insert(ms);
                s.entries += entries.len();
            }
            CatalogEvent::Done { total, .. } => {
                s.done_ms = Some(ms);
                s.done_total = Some(total);
            }
            CatalogEvent::Dims { items, .. } => {
                s.last_dims_ms = Some(ms);
                s.dims += items.len();
            }
        }
    });

    let s = stats.into_inner().unwrap();
    println!("首个 Batch: {} ms", s.first_batch_ms.unwrap_or(0));
    println!("Done: {} ms", s.done_ms.unwrap_or(0));
    println!("最后一个 Dims: {} ms", s.last_dims_ms.unwrap_or(0));
    println!("收到条目 {} 个，补到尺寸 {} 个", s.entries, s.dims);

    assert_eq!(s.done_total, Some(10000));
    assert_eq!(s.entries, 10000);
}
