//! 对比篮的持久化：只在 session.json 里存路径，前端仍只见 `FileId`。
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::State;

use crate::catalog::details::{self, BasketEntry};
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::scan;
use crate::catalog::session;
use crate::fileops::fsx::FsError;
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

/// 浏览目录里的一张图。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// 浏览一个目录的结果：目录名与里面（只一层）的图。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub name: String,
    pub entries: Vec<BrowseEntry>,
}

/// 只扫一层，复用扫描的跳过规则与扩展名，并登记 id；顺序不保证。读目录，不上主线程。
/// 先按目录会话的规则规范化路径，同一文件经符号链接或不同写法浏览也得到同一个 id；
/// 显示名仍取对话框给的路径。
pub fn run_browse(registry: &Registry, dir: &Path) -> Result<BrowseResult, FsError> {
    if !dir.is_dir() {
        return Err(FsError::NotFound);
    }
    let root = session::canonical_dir(dir).map_err(|_| FsError::NotFound)?;
    let mut entries = Vec::new();
    scan::scan(&root, false, &AtomicBool::new(false), &mut |batch| {
        entries.extend(batch.into_iter().map(|e| {
            BrowseEntry {
                id: registry.register(&e.path).0,
                name: e
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: e.size,
                mtime_ms: e.mtime_ms as f64,
            }
        }));
    });
    Ok(BrowseResult {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        entries,
    })
}

/// 浏览一个目录（添加面板的“其他文件夹”）。路径来自系统文件夹对话框。
#[tauri::command]
pub async fn browse_dir(
    path: String,
    registry: State<'_, Arc<Registry>>,
) -> Result<BrowseResult, FsError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_browse(&registry, Path::new(&path)))
        .await
        .map_err(|_| FsError::Other)?
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

    fn browse_tree(root: &Path) {
        for rel in [
            "a.png",
            "b.JPG",
            ".hidden.png",
            "a.txt",
            "sub/deep.png",
            "node_modules/x.png",
        ] {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, [0u8]).unwrap();
        }
    }

    #[test]
    fn browse_one_level_only() {
        let tmp = tempfile::tempdir().unwrap();
        browse_tree(tmp.path());
        let r = run_browse(&Registry::default(), tmp.path()).unwrap();
        let mut names: Vec<_> = r.entries.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["a.png", "b.JPG"]);
        assert_eq!(r.name, tmp.path().file_name().unwrap().to_string_lossy());
    }

    #[test]
    fn browse_skips_hidden_and_non_images() {
        let tmp = tempfile::tempdir().unwrap();
        browse_tree(tmp.path());
        let r = run_browse(&Registry::default(), tmp.path()).unwrap();
        for bad in [".hidden.png", "a.txt", "x.png"] {
            assert!(r.entries.iter().all(|e| e.name != bad), "{bad}");
        }
    }

    #[test]
    fn browse_registers_same_id_as_catalog() {
        let tmp = tempfile::tempdir().unwrap();
        browse_tree(tmp.path());
        let registry = Registry::default();
        // 目录会话登记的是按 canonical_dir 规范化后的路径（macOS 上临时目录 /var 实为 /private/var；
        // Windows 上不规范化，fs::canonicalize 会加 \\?\ 前缀，与目录会话不一致）
        let canon = session::canonical_dir(tmp.path()).unwrap();
        let id = registry.register(&canon.join("a.png"));
        let r = run_browse(&registry, tmp.path()).unwrap();
        let e = r.entries.iter().find(|e| e.name == "a.png").unwrap();
        assert_eq!(e.id, id.0);
        assert_eq!(e.size, 1);
    }

    #[cfg(unix)]
    #[test]
    fn browse_via_symlink_registers_canonical_id() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        browse_tree(&real);
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let registry = Registry::default();
        let id = registry.register(&fs::canonicalize(&real).unwrap().join("a.png"));
        let r = run_browse(&registry, &link).unwrap();
        let e = r.entries.iter().find(|e| e.name == "a.png").unwrap();
        assert_eq!(e.id, id.0);
        assert_eq!(r.name, "link");
    }

    #[test]
    fn browse_not_a_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let f = write(tmp.path(), "a.png");
        assert_eq!(
            run_browse(&Registry::default(), &f).unwrap_err(),
            FsError::NotFound
        );
        assert_eq!(
            run_browse(&Registry::default(), &tmp.path().join("nope")).unwrap_err(),
            FsError::NotFound
        );
    }
}
