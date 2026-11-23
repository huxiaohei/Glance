//! 缩略图磁盘缓存。键由路径、大小、修改时间与档位决定，原图变化后旧缓存自然失效。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use super::Tier;

/// 32 个十六进制字符。路径、大小、修改时间、档位任一不同，键就不同。
pub fn cache_key(path: &Path, size: u64, mtime_ms: i64, tier: Tier) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    // 路径字节不定长，用分隔字节避免与后续字段相互串接。
    hasher.update(&[0]);
    hasher.update(&size.to_le_bytes());
    hasher.update(&mtime_ms.to_le_bytes());
    hasher.update(&tier.px().to_le_bytes());
    let hash = hasher.finalize();
    hash.as_bytes()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub struct ThumbCache {
    dir: PathBuf,
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

impl ThumbCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// <dir>/<键前两位>/<键>.webp
    pub fn file_for(&self, key: &str) -> PathBuf {
        let prefix = key.get(..2).unwrap_or(key);
        self.dir.join(prefix).join(format!("{key}.webp"))
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        std::fs::read(self.file_for(key)).ok()
    }

    pub fn contains(&self, key: &str) -> bool {
        self.file_for(key).is_file()
    }

    /// 先写同目录临时文件，再原子改名；目录按需创建。
    pub fn put(&self, key: &str, bytes: &[u8]) -> std::io::Result<()> {
        let target = self.file_for(key);
        let parent = target.parent().expect("cache file has a parent");
        std::fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(
            ".{key}.{}.{}.tmp",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            std::fs::rename(&tmp, &target)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }

    /// 读文件当前的大小和修改时间来算键；文件不存在返回 None。
    pub fn key_for_file(path: &Path, tier: Tier) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime_ms = meta
            .modified()
            .ok()
            .map(|t| match t.duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_millis() as i64,
                Err(e) => -(e.duration().as_millis() as i64),
            })
            .unwrap_or(0);
        Some(cache_key(path, meta.len(), mtime_ms, tier))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn key_depends_on_every_input() {
        let k = cache_key(Path::new("/a/图 1.png"), 10, 1000, Tier::S);
        assert_eq!(k.len(), 32);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(k, cache_key(Path::new("/a/图 1.png"), 10, 1000, Tier::S));
        for other in [
            cache_key(Path::new("/a/图 2.png"), 10, 1000, Tier::S),
            cache_key(Path::new("/a/图 1.png"), 11, 1000, Tier::S),
            cache_key(Path::new("/a/图 1.png"), 10, 1001, Tier::S),
            cache_key(Path::new("/a/图 1.png"), 10, 1000, Tier::L),
        ] {
            assert_ne!(k, other);
        }
    }

    #[test]
    fn put_then_get_and_leaves_no_temp_files() {
        let root = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(root.path().to_path_buf());
        let key = format!("ab{}", "0".repeat(30));
        cache.put(&key, b"webp-bytes").unwrap();
        assert_eq!(cache.get(&key), Some(b"webp-bytes".to_vec()));
        assert!(cache.contains(&key));
        let file = cache.file_for(&key);
        assert_eq!(file, root.path().join("ab").join(format!("{key}.webp")));
        assert!(file.exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("ab")).unwrap().count(),
            1
        );
        let other = format!("cd{}", "1".repeat(30));
        assert_eq!(cache.get(&other), None);
        assert!(!cache.contains(&other));
    }

    #[test]
    fn key_for_file_tracks_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.png");
        std::fs::write(&f, b"one").unwrap();
        let k1 = ThumbCache::key_for_file(&f, Tier::S).unwrap();
        std::fs::write(&f, b"one-more").unwrap();
        let k2 = ThumbCache::key_for_file(&f, Tier::S).unwrap();
        assert_ne!(k1, k2);
        std::fs::remove_file(&f).unwrap();
        assert_eq!(ThumbCache::key_for_file(&f, Tier::S), None);
    }
}
