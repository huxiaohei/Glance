//! 面向前端的正式命令。

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::catalog::events::{CatalogEvent, OpenError, RootInfo};
use crate::catalog::registry::Registry;
use crate::catalog::session::{Sessions, resolve_open_target, run};

/// 打开目录或图片文件。扫描在后台线程里进行，事件经 on_event 推送。
/// 命令的返回值与 Channel 消息是相互独立的 IPC 消息，后端不保证先后：事件可能先于
/// 本命令的响应到达。约定由前端保证：拿到 RootInfo 之前先缓存收到的事件，
/// 并丢弃 generation 与当前代号不一致的事件。
#[tauri::command]
pub async fn open_path(
    app: AppHandle,
    path: String,
    recursive: bool,
    on_event: Channel<CatalogEvent>,
    registry: State<'_, Registry>,
    sessions: State<'_, Sessions>,
) -> Result<RootInfo, OpenError> {
    let target = resolve_open_target(&PathBuf::from(path), recursive)?;
    let focus = target
        .focus_file
        .as_deref()
        .map(|file| registry.register(file).0);
    let (generation, cancel) = sessions.begin();
    let info = RootInfo {
        generation,
        path: target.root.to_string_lossy().into_owned(),
        name: target
            .root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| target.root.to_string_lossy().into_owned()),
        recursive: target.recursive,
        focus,
    };

    // 扫描与读文件头不得占用主线程或异步运行时的核心线程。
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<Registry>();
        run(generation, &target, &registry, &cancel, &|event| {
            // webview 可能已经消失，发送失败不是错误。
            let _ = on_event.send(event);
        });
    });
    Ok(info)
}
