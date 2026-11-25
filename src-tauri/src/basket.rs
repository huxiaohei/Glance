//! 对比篮的持久化：只在 session.json 里存路径，前端仍只见 `FileId`。
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::catalog::details::{self, BasketEntry};
use crate::catalog::registry::{FileId, Registry};
use crate::state::session::SessionStore;

/// 启动恢复出的一项。文件不在时 `entry` 为 None，名字仍取自路径。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredItem {
    pub id: u32,
    pub name: String,
    pub dir_name: String,
    pub entry: Option<BasketEntry>,
}

/// 把篮里的 id 换成路径存盘；换不到路径的跳过。写盘，不上主线程。
pub fn run_save(registry: &Registry, store: &SessionStore, ids: &[u32]) {
    let paths = ids
        .iter()
        .filter_map(|&id| registry.path(FileId(id)))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    store.set_basket(paths);
}

/// 读出存下的路径并登记；同一路径只留首次位置。读文件，不上主线程。
pub fn run_restore(registry: &Registry, store: &SessionStore) -> Vec<RestoredItem> {
    let mut seen = HashSet::new();
    store
        .basket()
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .map(|p| {
            let path = Path::new(&p);
            let id = registry.register(path);
            let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
            RestoredItem {
                id: id.0,
                name: name_of(path).unwrap_or_default(),
                dir_name: path.parent().and_then(name_of).unwrap_or_default(),
                entry: details::basket_entry_meta(registry, id),
            }
        })
        .collect()
}

/// 保存对比篮（只存路径）。
#[tauri::command]
pub async fn basket_save(
    ids: Vec<u32>,
    registry: State<'_, Arc<Registry>>,
    store: State<'_, Arc<SessionStore>>,
) -> Result<(), String> {
    let (registry, store) = (registry.inner().clone(), store.inner().clone());
    tauri::async_runtime::spawn_blocking(move || run_save(&registry, &store, &ids))
        .await
        .map_err(|e| e.to_string())
}

/// 启动时恢复对比篮。
#[tauri::command]
pub async fn basket_restore(
    registry: State<'_, Arc<Registry>>,
    store: State<'_, Arc<SessionStore>>,
) -> Result<Vec<RestoredItem>, String> {
    let (registry, store) = (registry.inner().clone(), store.inner().clone());
    tauri::async_runtime::spawn_blocking(move || run_restore(&registry, &store))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::Registry;
    use crate::state::session::SessionStore;
    use std::fs;
    use std::path::Path;

    fn write(dir: &Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"not really an image").unwrap();
        p
    }

    #[test]
    fn save_then_restore_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let a = write(tmp.path(), "a.png");
        let b = write(tmp.path(), "b.png");
        let registry = Registry::default();
        let (ia, ib) = (registry.register(&a), registry.register(&b));
        let store = SessionStore::memory();
        run_save(&registry, &store, &[ib.0, ia.0]);

        let fresh = Registry::default();
        let items = run_restore(&fresh, &store);
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["b.png", "a.png"]);
        for it in &items {
            let e = it.entry.as_ref().unwrap();
            assert_eq!(e.id, it.id);
            assert_eq!((e.w, e.h), (None, None));
        }
    }

    #[test]
    fn restore_marks_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let a = write(tmp.path(), "a.png");
        let registry = Registry::default();
        let ia = registry.register(&a);
        let store = SessionStore::memory();
        run_save(&registry, &store, &[ia.0]);
        fs::remove_file(&a).unwrap();

        let items = run_restore(&Registry::default(), &store);
        assert_eq!(items.len(), 1);
        assert!(items[0].entry.is_none());
        assert_eq!(items[0].name, "a.png");
        let dir = tmp.path().file_name().unwrap().to_string_lossy();
        assert_eq!(items[0].dir_name, dir);
    }

    #[test]
    fn restore_dedups_paths() {
        let store = SessionStore::memory();
        store.set_basket(vec!["/p/a.png".into(), "/p/a.png".into()]);
        assert_eq!(run_restore(&Registry::default(), &store).len(), 1);
    }

    #[test]
    fn save_skips_unknown_ids() {
        let store = SessionStore::memory();
        run_save(&Registry::default(), &store, &[9999]);
        assert!(store.basket().is_empty());
    }
}
