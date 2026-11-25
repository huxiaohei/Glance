//! 会话状态：`<配置目录>/session.json`。有最近的移动 / 复制目标与对比篮。
//! 整个文件只由 `SessionStore` 写：各字段的持有者都经它改，免得互相覆盖。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::store;

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionFile {
    pub recent_targets: Vec<String>,
    pub basket: Vec<String>,
}

/// `session.json` 的内存副本与唯一写入方；没有落盘路径时只在内存里。
#[derive(Default)]
pub struct SessionStore {
    file: Mutex<SessionFile>,
    path: Option<PathBuf>,
}

impl SessionStore {
    /// 读 `<config_dir>/session.json`；读不出就是空。
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("session.json");
        Self {
            file: Mutex::new(store::load(&path)),
            path: Some(path),
        }
    }

    /// 不落盘，测试用。
    pub fn memory() -> Self {
        Self::default()
    }

    pub fn recent_targets(&self) -> Vec<String> {
        self.lock().recent_targets.clone()
    }

    pub fn set_recent_targets(&self, v: Vec<String>) {
        self.update(|f| f.recent_targets = v);
    }

    pub fn basket(&self) -> Vec<String> {
        self.lock().basket.clone()
    }

    pub fn set_basket(&self, v: Vec<String>) {
        self.update(|f| f.basket = v);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SessionFile> {
        self.file.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 锁内改字段后整体写盘；写失败静默。
    fn update(&self, change: impl FnOnce(&mut SessionFile)) {
        let mut file = self.lock();
        change(&mut file);
        if let Some(path) = &self.path {
            let _ = store::save(path, &*file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_file_without_basket_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session.json"),
            r#"{"recentTargets":["/a"]}"#,
        )
        .unwrap();
        let s = SessionStore::load(dir.path());
        assert!(s.basket().is_empty());
        assert_eq!(s.recent_targets(), vec!["/a".to_string()]);
    }

    #[test]
    fn set_basket_keeps_recent_targets() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::load(dir.path());
        s.set_recent_targets(vec!["/a".into()]);
        s.set_basket(vec!["/x.png".into()]);
        let again = SessionStore::load(dir.path());
        assert_eq!(again.recent_targets(), vec!["/a".to_string()]);
        assert_eq!(again.basket(), vec!["/x.png".to_string()]);
    }

    #[test]
    fn memory_store_does_not_touch_the_disk() {
        let s = SessionStore::memory();
        s.set_basket(vec!["/x.png".into()]);
        assert_eq!(s.basket(), vec!["/x.png".to_string()]);
        assert!(s.path.is_none());
    }
}
