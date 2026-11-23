use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, serde::Serialize, serde::Deserialize)]
pub struct FileId(pub u32);

#[derive(Default)]
struct Inner {
    by_path: HashMap<PathBuf, FileId>,
    by_id: HashMap<FileId, PathBuf>,
    last: u32,
}

/// 文件 ID 与路径的双向登记表。前端与协议 URL 只携带 ID。
#[derive(Default)]
pub struct Registry {
    inner: RwLock<Inner>,
}

impl Registry {
    /// 同一路径重复登记返回同一个 ID。ID 从 1 开始递增。
    pub fn register(&self, path: &Path) -> FileId {
        if let Some(id) = self.inner.read().unwrap().by_path.get(path) {
            return *id;
        }
        let mut inner = self.inner.write().unwrap();
        if let Some(id) = inner.by_path.get(path) {
            return *id;
        }
        inner.last += 1;
        let id = FileId(inner.last);
        inner.by_path.insert(path.to_path_buf(), id);
        inner.by_id.insert(id, path.to_path_buf());
        id
    }

    pub fn path(&self, id: FileId) -> Option<PathBuf> {
        self.inner.read().unwrap().by_id.get(&id).cloned()
    }

    /// 改名后 ID 不变。旧路径未登记时返回 None。
    pub fn rename(&self, from: &Path, to: &Path) -> Option<FileId> {
        let mut inner = self.inner.write().unwrap();
        let id = inner.by_path.remove(from)?;
        inner.by_path.insert(to.to_path_buf(), id);
        inner.by_id.insert(id, to.to_path_buf());
        Some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn same_path_same_id() {
        let r = Registry::default();
        let a = r.register(Path::new("/a/武将 立绘/蜀国#1/赵云 100%.png"));
        let b = r.register(Path::new("/a/武将 立绘/蜀国#1/赵云 100%.png"));
        assert_eq!(a, b);
        assert_eq!(a, FileId(1));
        assert_eq!(r.register(Path::new("/a/b.png")), FileId(2));
    }

    #[test]
    fn rename_keeps_id() {
        let r = Registry::default();
        let id = r.register(Path::new("/a/old.png"));
        assert_eq!(
            r.rename(Path::new("/a/old.png"), Path::new("/a/new.png")),
            Some(id)
        );
        assert_eq!(r.path(id), Some(PathBuf::from("/a/new.png")));
        assert_eq!(r.register(Path::new("/a/new.png")), id);
        assert_eq!(
            r.rename(Path::new("/a/missing.png"), Path::new("/a/x.png")),
            None
        );
    }

    #[test]
    fn unknown_id_is_none() {
        assert_eq!(Registry::default().path(FileId(99)), None);
    }
}
