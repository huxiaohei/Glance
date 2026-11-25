//! 编辑命令。读文件、解码、编码都不在主线程：打开在阻塞线程池上做，预览在会话线程上算，
//! 命令只在阻塞线程池上等应答。

use std::sync::Arc;

use glance_imaging::EditParams;
use tauri::State;

use super::{EditError, EditOpened, EditState, PreviewResult};
use crate::catalog::registry::{FileId, Registry};

/// 打开编辑会话（先关旧的）。动图返回 `Animated`，不建会话。
#[tauri::command]
pub async fn edit_open(
    id: u32,
    registry: State<'_, Arc<Registry>>,
    edit: State<'_, Arc<EditState>>,
) -> Result<EditOpened, EditError> {
    let (registry, edit) = (registry.inner().clone(), edit.inner().clone());
    tauri::async_runtime::spawn_blocking(move || edit.open(&registry, FileId(id)))
        .await
        .map_err(|_| EditError::Decode)?
}

/// 请求一次预览；被更新的请求取代或会话已关时返回 `None`。
#[tauri::command]
pub async fn edit_preview(
    session: u32,
    rev: u32,
    params: EditParams,
    full: bool,
    edit: State<'_, Arc<EditState>>,
) -> Result<Option<PreviewResult>, EditError> {
    let rx = edit.submit(session, rev, params, full)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Ok(None)))
        .await
        .map_err(|_| EditError::Encode)?
}

/// 关闭编辑会话；会话号不是当前会话时什么也不做。释放大块内存，不在主线程上做。
#[tauri::command(async)]
pub fn edit_close(session: u32, edit: State<'_, Arc<EditState>>) {
    edit.close(session);
}
