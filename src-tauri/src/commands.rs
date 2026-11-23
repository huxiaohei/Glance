//! 面向前端的正式命令。

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::catalog::events::{CatalogEvent, OpenError, RootInfo};
use crate::catalog::registry::Registry;
use crate::catalog::session::{Sessions, resolve_open_target, run};

/// 打开目录或图片文件。先返回 RootInfo，之后才在后台线程里扫描并经 on_event 推送事件，
/// 因此前端先拿到代号，再收到带该代号的事件。
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
