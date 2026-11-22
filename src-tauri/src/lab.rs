//! 开发期实验命令，仅 debug 构建编译。

use crate::catalog::registry::Registry;
use crate::fileops::trash::{self, TrashHandle};
use crate::protocol::HITS;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::State;

#[derive(serde::Serialize)]
pub struct LabEntry {
    pub id: u32,
    pub name: String,
    pub size: u64,
}

/// 登记目录下一层（不递归）的全部文件。
#[tauri::command]
pub async fn lab_register_dir(
    registry: State<'_, Registry>,
    path: String,
) -> Result<Vec<LabEntry>, String> {
    let dir = PathBuf::from(path);
    let mut files: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| (entry.path(), meta.len()))
        })
        .collect();
    files.sort();
    Ok(files
        .into_iter()
        .map(|(path, size)| LabEntry {
            id: registry.register(&path).0,
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size,
        })
        .collect())
}

#[tauri::command]
pub fn lab_protocol_hits() -> u64 {
    HITS.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn lab_trash(path: String) -> Result<TrashHandle, String> {
    trash::move_to_trash(&PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lab_restore(handle: TrashHandle) -> Result<(), String> {
    trash::restore(&handle).map_err(|e| e.to_string())
}
