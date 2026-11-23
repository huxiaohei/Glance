//! 面向前端的正式命令。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::catalog::events::{CatalogEvent, OpenError, RootInfo};
use crate::catalog::registry::FileId;
use crate::catalog::registry::Registry;
use crate::catalog::session::{Sessions, resolve_open_target, run};
use crate::thumbs::{ThumbEvent, Thumbs, Tier};

/// 打开目录或图片文件。扫描在后台线程里进行，事件经 on_event 推送。
/// 命令的返回值与 Channel 消息是相互独立的 IPC 消息，后端不保证先后：事件可能先于
/// 本命令的响应到达。约定由前端保证：拿到 RootInfo 之前先缓存收到的事件，
/// 并丢弃 generation 与当前代号不一致的事件。
#[tauri::command]
pub async fn open_path(
    app: AppHandle,
    path: String,
    recursive: bool,
    seq: u64,
    on_event: Channel<CatalogEvent>,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
) -> Result<RootInfo, OpenError> {
    // 先登记序号：之后到达的、序号更小的请求即使更晚走到 begin 也会被拒绝。
    sessions.note(seq);
    let path = PathBuf::from(path);
    // stat 可能阻塞（网络盘等），不占异步运行时的核心线程。
    let target = tauri::async_runtime::spawn_blocking(move || resolve_open_target(&path, recursive))
        .await
        .map_err(|_| OpenError::Unreadable)??;
    let Some((generation, cancel)) = sessions.begin(seq) else {
        return Err(OpenError::Superseded);
    };
    let focus = target
        .focus_file
        .as_deref()
        .map(|file| registry.register(file).0);
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
        let registry = app.state::<Arc<Registry>>();
        run(generation, &target, &registry, &cancel, &|event| {
            // webview 可能已经消失，发送失败不是错误。
            let _ = on_event.send(event);
        });
    });
    Ok(info)
}

/// 订阅缩略图事件，替换上一个订阅者。webview 消失后发送失败，直接忽略。
#[tauri::command]
pub fn thumbs_subscribe(on_event: Channel<ThumbEvent>, thumbs: State<'_, Arc<Thumbs>>) {
    thumbs.subscribe(Box::new(move |event| {
        let _ = on_event.send(event);
    }));
}

/// 整体替换该消费者想要的缩略图集合；返回其中已有缓存的 ID，其余稍后经事件送达。
#[tauri::command(async)]
pub fn thumbs_want(
    consumer: String,
    ids: Vec<u32>,
    tier: u32,
    thumbs: State<'_, Arc<Thumbs>>,
) -> Result<Vec<u32>, String> {
    let tier = Tier::from_px(tier).ok_or_else(|| format!("invalid thumbnail tier: {tier}"))?;
    let ids: Vec<FileId> = ids.into_iter().map(FileId).collect();
    Ok(thumbs
        .want(&consumer, &ids, tier)
        .into_iter()
        .map(|id| id.0)
        .collect())
}
