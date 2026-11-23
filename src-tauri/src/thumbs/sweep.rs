//! 缩略图缓存的容量上限：启动时清扫，按最后使用时间（文件修改时间）从旧到新淘汰。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const CACHE_LIMIT: u64 = 1 << 30;
pub const CACHE_TARGET: u64 = CACHE_LIMIT / 10 * 9;
pub const TMP_MAX_AGE: Duration = Duration::from_secs(3600);

pub struct CacheFile {
    pub path: PathBuf,
    pub size: u64,
    pub used: SystemTime,
}

/// 总量不超过 limit 时返回空；否则按 used 从旧到新选出要删的文件，直到剩余总量不超过 target。
pub fn plan_evictions(files: Vec<CacheFile>, limit: u64, target: u64) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|f| f.size).sum();
    if total <= limit {
        return Vec::new();
    }
    let mut files = files;
    files.sort_by_key(|f| f.used);
    let mut plan = Vec::new();
    for f in files {
        if total <= target {
            break;
        }
        total -= f.size;
        plan.push(f.path);
    }
    plan
}

#[derive(Debug, Default, PartialEq)]
pub struct SweepReport {
    pub removed: u64,
    pub freed: u64,
    pub tmp_removed: u64,
}

/// 删除一个计划中的文件；文件已不在或删不掉返回 false。
fn remove_planned(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok()
}

/// 只看 <dir>/<两位十六进制>/ 这一层里的文件：`*.webp` 参与容量计算，
/// 以 `.` 开头、`.tmp` 结尾且修改时间早于 now - TMP_MAX_AGE 的删除；其余文件和更深的目录不碰。
/// 目录不存在返回默认报告；单个条目读不出或删不掉就跳过。
pub fn sweep(dir: &Path, limit: u64, target: u64, now: SystemTime) -> SweepReport {
    let mut report = SweepReport::default();
    let Ok(top) = std::fs::read_dir(dir) else {
        return report;
    };
    let tmp_cutoff = now.checked_sub(TMP_MAX_AGE);
    let mut files = Vec::new();
    let mut sizes = std::collections::HashMap::new();
    for shard in top.flatten() {
        let name = shard.file_name();
        let name = name.to_string_lossy();
        if name.len() != 2 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let path = entry.path();
            if file_name.ends_with(".webp") {
                sizes.insert(path.clone(), meta.len());
                files.push(CacheFile {
                    path,
                    size: meta.len(),
                    used: modified,
                });
            } else if file_name.starts_with('.')
                && file_name.ends_with(".tmp")
                && tmp_cutoff.is_some_and(|c| modified < c)
                && remove_planned(&path)
            {
                report.tmp_removed += 1;
            }
        }
    }
    for path in plan_evictions(files, limit, target) {
        if remove_planned(&path) {
            report.removed += 1;
            report.freed += sizes.get(&path).copied().unwrap_or(0);
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, FileTimes};

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn set_time(path: &Path, t: SystemTime) {
        let f = File::options().write(true).open(path).unwrap();
        f.set_times(FileTimes::new().set_modified(t)).unwrap();
    }

    fn cf(name: &str, size: u64, used: u64) -> CacheFile {
        CacheFile {
            path: PathBuf::from(name),
            size,
            used: at(used),
        }
    }

    fn five() -> Vec<CacheFile> {
        // 故意乱序
        vec![
            cf("c", 100, 3),
            cf("a", 100, 1),
            cf("e", 100, 5),
            cf("b", 100, 2),
            cf("d", 100, 4),
        ]
    }

    fn make(dir: &Path, rel: &str, size: usize, t: SystemTime) -> PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![0u8; size]).unwrap();
        set_time(&p, t);
        p
    }

    #[test]
    fn under_the_limit_nothing_is_evicted() {
        assert!(plan_evictions(five(), 1000, 900).is_empty());
    }

    #[test]
    fn evicts_oldest_first_until_at_or_below_target() {
        let plan = plan_evictions(five(), 400, 300);
        assert_eq!(plan, vec![PathBuf::from("a"), PathBuf::from("b")]);
    }

    #[test]
    fn exactly_at_the_limit_is_not_over() {
        assert!(plan_evictions(five(), 500, 300).is_empty());
    }

    #[test]
    fn sweep_removes_planned_files_and_reports_bytes() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let old = make(
            root.path(),
            "ab/old.webp",
            100,
            now - Duration::from_secs(300),
        );
        let mid = make(
            root.path(),
            "cd/mid.webp",
            100,
            now - Duration::from_secs(200),
        );
        let new = make(
            root.path(),
            "ab/new.webp",
            100,
            now - Duration::from_secs(100),
        );
        let report = sweep(root.path(), 250, 150, now);
        assert_eq!(
            report,
            SweepReport {
                removed: 2,
                freed: 200,
                tmp_removed: 0
            }
        );
        assert!(!old.exists() && !mid.exists());
        assert!(new.exists());
    }

    #[test]
    fn sweep_removes_only_stale_tmp_files() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let stale = make(
            root.path(),
            "ab/.k.1.0.tmp",
            10,
            now - Duration::from_secs(7200),
        );
        let fresh = make(root.path(), "ab/.k.1.1.tmp", 10, now);
        let report = sweep(root.path(), CACHE_LIMIT, CACHE_TARGET, now);
        assert_eq!(
            report,
            SweepReport {
                removed: 0,
                freed: 0,
                tmp_removed: 1
            }
        );
        assert!(!stale.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn sweep_ignores_files_outside_the_two_level_layout() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let t = now - Duration::from_secs(10_000);
        let a = make(root.path(), "note.txt", 500, t);
        let b = make(root.path(), "ab/deep/x.webp", 500, t);
        let c = make(root.path(), "ab/readme", 500, t);
        let d = make(root.path(), "ab/deep/.y.tmp", 500, t);
        let report = sweep(root.path(), 100, 50, now);
        assert_eq!(report, SweepReport::default());
        assert!(a.exists() && b.exists() && c.exists() && d.exists());
    }

    #[test]
    fn sweep_of_a_missing_dir_reports_nothing() {
        let root = tempfile::tempdir().unwrap();
        let report = sweep(&root.path().join("nope"), 100, 50, SystemTime::now());
        assert_eq!(report, SweepReport::default());
    }

    #[test]
    fn sweep_survives_a_file_vanishing_midway() {
        let root = tempfile::tempdir().unwrap();
        assert!(!remove_planned(&root.path().join("ab/gone.webp")));
        let real = make(root.path(), "ab/x.webp", 5, SystemTime::now());
        assert!(remove_planned(&real));
        assert!(!real.exists());
    }
}
