//! 目录扫描：遍历目录，把图片分批交给回调。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, PartialEq)]
pub struct ScanEntry {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

pub const BATCH_SIZE: usize = 500;
pub const BATCH_INTERVAL: Duration = Duration::from_millis(50);
pub const IGNORED_DIRS: [&str; 6] = [
    ".git",
    "node_modules",
    ".svn",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
];

/// 扩展名为 png / jpg / jpeg / webp / gif / bmp（不分大小写）。
pub fn is_image_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        ["png", "jpg", "jpeg", "webp", "gif", "bmp"]
            .iter()
            .any(|x| e.eq_ignore_ascii_case(x))
    })
}

/// 单级名称是否要跳过：点开头，或是被忽略的目录名。
fn is_skipped_name(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && IGNORED_DIRS.contains(&name))
}

/// Windows 上带隐藏属性的条目要跳过。
#[cfg(windows)]
fn is_hidden_attr(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

/// 其他系统没有隐藏属性，只按名称判断。
#[cfg(not(windows))]
fn is_hidden_attr(_meta: &std::fs::Metadata) -> bool {
    false
}

/// root 的下级条目是否要跳过：点开头、被忽略的目录、Windows 隐藏属性。
fn is_skipped(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    is_skipped_name(&name, entry.file_type().is_dir())
        // 只有 Windows 需要多读一次元数据
        || (cfg!(windows) && entry.metadata().is_ok_and(|m| is_hidden_attr(&m)))
}

/// root 之下的 path 是否要跳过：root 之后的任一级名称以点开头、或某级目录名在
/// IGNORED_DIRS 里；Windows 上再看 path 自身的隐藏属性。root 自身不参与判断。
/// path 不在 root 之下时返回 false，范围由调用方另行判断。
/// 末级若已不存在（如刚被删除的目录），按目录看待。
pub fn is_skipped_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let names: Vec<_> = rel.components().map(|c| c.as_os_str()).collect();
    let Some((last, parents)) = names.split_last() else {
        return false;
    };
    if parents
        .iter()
        .any(|n| is_skipped_name(&n.to_string_lossy(), true))
    {
        return true;
    }
    let meta = std::fs::symlink_metadata(path).ok();
    let last_is_dir = meta.as_ref().is_none_or(|m| m.is_dir());
    is_skipped_name(&last.to_string_lossy(), last_is_dir)
        || meta.is_some_and(|m| is_hidden_attr(&m))
}

/// 文件的大小与修改时间：内容有没有变的判据。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stamp {
    pub size: u64,
    pub mtime_ms: i64,
}

impl Stamp {
    /// 供地址里的 `?v=` 使用的版本串。
    pub fn version(&self) -> String {
        format!("{}-{}", self.mtime_ms, self.size)
    }
}

/// 读文件当前的状态；文件不存在或读不了返回 None。取不到修改时间时按 0 处理。
pub fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp {
        size: meta.len(),
        mtime_ms: mtime_ms_of(&meta).unwrap_or(0),
    })
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> Option<i64> {
    Some(match meta.modified().ok()?.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    })
}

fn to_entry(entry: &DirEntry) -> Option<ScanEntry> {
    let meta = entry.metadata().ok()?;
    Some(ScanEntry {
        path: entry.path().to_path_buf(),
        size: meta.len(),
        mtime_ms: mtime_ms_of(&meta)?,
    })
}

/// 遍历 root，把找到的图片分批交给 on_batch；每批至多 BATCH_SIZE 条，
/// 距上一批超过 BATCH_INTERVAL 且有积压时也会发出。cancel 置位后尽快返回。
/// 返回找到的图片总数。读不了的目录和文件静默跳过。
pub fn scan(
    root: &Path,
    recursive: bool,
    cancel: &AtomicBool,
    on_batch: &mut dyn FnMut(Vec<ScanEntry>),
) -> usize {
    let mut walker = WalkDir::new(root).follow_links(false);
    if !recursive {
        walker = walker.max_depth(1);
    }
    // depth 0 是 root 本身，不受忽略规则约束。
    let iter = walker
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_skipped(e));

    let mut total = 0;
    let mut pending: Vec<ScanEntry> = Vec::new();
    let mut last_emit = Instant::now();
    for entry in iter {
        if cancel.load(Ordering::Relaxed) {
            return total;
        }
        if !pending.is_empty() && last_emit.elapsed() >= BATCH_INTERVAL {
            on_batch(std::mem::take(&mut pending));
            last_emit = Instant::now();
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() || !is_image_path(entry.path()) {
            continue;
        }
        let Some(item) = to_entry(&entry) else {
            continue;
        };
        pending.push(item);
        total += 1;
        if pending.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_INTERVAL {
            on_batch(std::mem::take(&mut pending));
            last_emit = Instant::now();
        }
    }
    if !pending.is_empty() && !cancel.load(Ordering::Relaxed) {
        on_batch(pending);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::Ordering;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, [0u8]).unwrap();
    }

    fn collect(root: &Path, recursive: bool) -> Vec<String> {
        let mut out = vec![];
        scan(root, recursive, &AtomicBool::new(false), &mut |batch| {
            for e in batch {
                let rel = e.path.strip_prefix(root).unwrap();
                let parts: Vec<_> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        });
        out.sort();
        out
    }

    fn awkward_tree(root: &Path) {
        for rel in [
            "a.png",
            "IMG2.PNG",
            "sub/b.jpeg",
            "武将 立绘/蜀国#1/赵云 100%.webp",
            "sub/deep/c.gif",
            "d.bmp",
            "e.JPG",
        ] {
            touch(root, rel);
        }
    }

    #[test]
    fn finds_images_recursively_with_awkward_names() {
        let dir = tempfile::tempdir().unwrap();
        awkward_tree(dir.path());
        assert_eq!(
            collect(dir.path(), true),
            vec![
                "IMG2.PNG",
                "a.png",
                "d.bmp",
                "e.JPG",
                "sub/b.jpeg",
                "sub/deep/c.gif",
                "武将 立绘/蜀国#1/赵云 100%.webp",
            ]
        );
    }

    #[test]
    fn non_recursive_sees_only_top_level() {
        let dir = tempfile::tempdir().unwrap();
        awkward_tree(dir.path());
        assert_eq!(
            collect(dir.path(), false),
            vec!["IMG2.PNG", "a.png", "d.bmp", "e.JPG"]
        );
    }

    #[test]
    fn skips_non_images_hidden_and_ignored() {
        let dir = tempfile::tempdir().unwrap();
        for rel in [
            "keep.png",
            "notes.txt",
            "noext",
            ".hidden.png",
            ".cache/x.png",
            "node_modules/y.png",
            ".git/z.png",
            "__pycache__/w.png",
            "ok/.DS_Store",
            "ok/v.png",
        ] {
            touch(dir.path(), rel);
        }
        assert_eq!(collect(dir.path(), true), vec!["keep.png", "ok/v.png"]);
    }

    #[test]
    fn skipped_path_follows_the_same_rules_as_scan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".secret");
        touch(&root, "ok/a.png");
        touch(&root, "node_modules/b.png");
        let skipped = |rel: &str| is_skipped_path(&root, &root.join(rel));
        assert!(!skipped("ok/a.png"));
        assert!(!skipped("ok"));
        assert!(!skipped("not/there.png"));
        assert!(skipped(".a.png"));
        assert!(skipped(".cache/x.png"));
        assert!(skipped("ok/.DS_Store"));
        assert!(skipped("node_modules/b.png"));
        assert!(skipped("node_modules"));
        assert!(skipped("deep/.git/z.png"));
        assert!(!skipped("node_modules2/c.png"));
        assert!(!is_skipped_path(&root, &root));
    }

    #[test]
    fn hidden_root_is_still_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".secret");
        touch(&root, "a.png");
        assert_eq!(collect(&root, true), vec!["a.png"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(root, "real/a.png");
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root, root.join("loop")).unwrap();
        assert_eq!(collect(root, true), vec!["real/a.png"]);
    }

    fn many_images(root: &Path, n: usize) {
        for i in 0..n {
            touch(root, &format!("img{i:04}.png"));
        }
    }

    #[test]
    fn batches_are_capped_and_total_is_returned() {
        let dir = tempfile::tempdir().unwrap();
        many_images(dir.path(), 1201);
        let mut sizes = vec![];
        let total = scan(dir.path(), true, &AtomicBool::new(false), &mut |b| {
            sizes.push(b.len())
        });
        assert_eq!(total, 1201);
        assert_eq!(sizes.iter().sum::<usize>(), 1201);
        assert!(sizes.iter().all(|&n| (1..=BATCH_SIZE).contains(&n)));
    }

    #[test]
    fn cancel_stops_early() {
        let dir = tempfile::tempdir().unwrap();
        many_images(dir.path(), 1201);
        let cancel = AtomicBool::new(false);
        let mut batches = 0;
        let total = scan(dir.path(), true, &cancel, &mut |_| {
            batches += 1;
            cancel.store(true, Ordering::Relaxed);
        });
        assert_eq!(batches, 1);
        assert!(total < 1201);
    }

    #[test]
    fn records_size_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.png"), [1u8; 5]).unwrap();
        let mut got = vec![];
        scan(dir.path(), true, &AtomicBool::new(false), &mut |b| {
            got.extend(b)
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].size, 5);
        let expected = fs::metadata(dir.path().join("a.png"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(got[0].mtime_ms, expected);
    }

    #[test]
    fn missing_root_yields_nothing() {
        assert_eq!(
            scan(
                Path::new("/definitely/not/here"),
                true,
                &AtomicBool::new(false),
                &mut |_| panic!()
            ),
            0
        );
    }
}
