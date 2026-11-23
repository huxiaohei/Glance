//! 面向前端的正式命令。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::catalog::details::{self, ImageDetails};
use crate::catalog::events::{CatalogEvent, OpenError, RootInfo};
use crate::catalog::registry::FileId;
use crate::catalog::registry::Registry;
use crate::catalog::session::{Sessions, resolve_open_target, root_display_name};
use crate::catalog::watch::{SessionMsg, serve};
use crate::thumbs::{ThumbEvent, Thumbs, Tier};

/// 打开目录或图片文件。扫描与之后的目录监听在一条专属的会话线程里进行，
/// 事件经 on_event 推送，直到下一次打开取消本次会话。
/// 命令的返回值与 Channel 消息是相互独立的 IPC 消息，后端不保证先后：事件可能先于
/// 本命令的响应到达。约定由前端保证：拿到 RootInfo 之前先缓存收到的事件，
/// 并丢弃 generation 与当前代号不一致的事件。
#[tauri::command]
pub async fn open_path(
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
    let (target, name) = tauri::async_runtime::spawn_blocking(move || {
        resolve_open_target(&path, recursive).map(|t| {
            let name = root_display_name(&path, &t);
            (t, name)
        })
    })
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
        name,
        recursive: target.recursive,
        focus,
    };

    // 会话的收件口：监听器与之后的文件操作（经 Sessions::hint）都往这里投递。
    let (tx, rx) = std::sync::mpsc::channel::<SessionMsg>();
    sessions.attach(generation, target.root.clone(), tx.clone());

    // 会话线程长期存活（监听直到下一次打开），不占 spawn_blocking 的线程池，
    // 也不占主线程或异步运行时的核心线程。
    let registry = Arc::clone(&registry);
    std::thread::Builder::new()
        .name("glance-session".into())
        .spawn(move || {
            serve(
                generation,
                target,
                registry,
                cancel,
                (tx, rx),
                Box::new(move |event| {
                    // webview 可能已经消失，发送失败不是错误。
                    let _ = on_event.send(event);
                }),
            );
        })
        .map_err(|_| OpenError::Unreadable)?;
    Ok(info)
}

/// 订阅缩略图事件，替换上一个订阅者。webview 消失后发送失败，直接忽略。
#[tauri::command]
pub fn thumbs_subscribe(on_event: Channel<ThumbEvent>, thumbs: State<'_, Arc<Thumbs>>) {
    thumbs.subscribe(Box::new(move |event| {
        let _ = on_event.send(event);
    }));
}

/// 已有缓存的缩略图及其生成时的文件版本。
#[derive(serde::Serialize)]
pub struct ReadyThumb {
    pub id: u32,
    pub v: String,
}

/// 整体替换该消费者想要的缩略图集合；返回其中已有缓存的项，其余稍后经事件送达。
#[tauri::command(async)]
pub fn thumbs_want(
    consumer: String,
    ids: Vec<u32>,
    tier: u32,
    thumbs: State<'_, Arc<Thumbs>>,
) -> Result<Vec<ReadyThumb>, String> {
    let tier = Tier::from_px(tier).ok_or_else(|| format!("invalid thumbnail tier: {tier}"))?;
    let ids: Vec<FileId> = ids.into_iter().map(FileId).collect();
    Ok(thumbs
        .want(&consumer, &ids, tier)
        .into_iter()
        .map(|(id, v)| ReadyThumb { id: id.0, v })
        .collect())
}

/// 单张图片的详情（信息面板用）。ID 经登记表换算路径；未登记或文件不在了返回 Err。
/// 读文件，不上主线程。
#[tauri::command(async)]
pub fn image_details(id: u32, registry: State<'_, Arc<Registry>>) -> Result<ImageDetails, String> {
    details::details_by_id(&registry, FileId(id))
}
