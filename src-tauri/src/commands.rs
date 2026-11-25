//! 面向前端的正式命令。

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{Manager, State};

use crate::catalog::details::{self, BasketEntry, ImageDetails};
use crate::catalog::events::{CatalogEvent, OpenError, RootInfo};
use crate::catalog::registry::FileId;
use crate::catalog::registry::Registry;
use crate::catalog::scan::is_image_path;
use crate::catalog::session::{
    OpenTarget, Sessions, rel_path, resolve_open_target, root_display_name,
};
use crate::catalog::watch::{SessionMsg, serve};
use crate::state::recents::{Note, RECENT_THUMBS, RecentEntry, RecentsState};
use crate::state::settings::SortKey;
use crate::thumbs::{ThumbCache, ThumbEvent, Thumbs, Tier};

/// 打开目录或图片文件。扫描与之后的目录监听在一条专属的会话线程里进行，
/// 事件经 on_event 推送，直到下一次打开取消本次会话。
/// 命令的返回值与 Channel 消息是相互独立的 IPC 消息，后端不保证先后：事件可能先于
/// 本命令的响应到达。约定由前端保证：拿到 RootInfo 之前先缓存收到的事件，
/// 并丢弃 generation 与当前代号不一致的事件。
///
/// `restore` 为真且打开的是目录时，把最近目录里记下的“上次看到的图片”登记为 focus
/// （文件仍在且是图片才算）。打开成功后把根目录记入最近目录；最近目录读写失败不影响打开。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_path(
    path: String,
    recursive: bool,
    seq: u64,
    restore: Option<bool>,
    on_event: Channel<CatalogEvent>,
    app: tauri::AppHandle,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
) -> Result<RootInfo, OpenError> {
    // 先登记序号：之后到达的、序号更小的请求即使更晚走到 begin 也会被拒绝。
    sessions.note(seq);
    let path = PathBuf::from(path);
    let restore = restore.unwrap_or(false);
    // stat 可能阻塞（网络盘等），不占异步运行时的核心线程。
    let handle = app.clone();
    let (target, name, focus_file) = tauri::async_runtime::spawn_blocking(move || {
        prepare_open(&path, recursive, restore, &handle.state::<RecentsState>())
    })
    .await
    .map_err(|_| OpenError::Unreadable)??;
    let Some((generation, cancel)) = sessions.begin(seq) else {
        return Err(OpenError::Superseded);
    };
    let focus = focus_file.as_deref().map(|file| registry.register(file).0);
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

    // 记入最近目录：写配置文件，不占核心线程；失败（含任务异常）只忽略。
    let (key, display) = (info.path.clone(), info.name.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let (sessions, recents) = (app.state::<Sessions>(), app.state::<RecentsState>());
        touch_if_current(&sessions, &recents, generation, &key, &display);
    })
    .await;
    Ok(info)
}

/// 把这次打开的根目录记入最近目录；期间已有更新的打开（`generation` 不再是当前会话）时丢弃，
/// 免得较早的打开排到较晚的前面。
pub(crate) fn touch_if_current(
    sessions: &Sessions,
    recents: &RecentsState,
    generation: u32,
    key: &str,
    name: &str,
) {
    if sessions.current().is_some_and(|(g, _)| g == generation) {
        recents.update(|l| l.touch(key, name));
    }
}

/// 打开前在阻塞线程里做的事：解析目标与显示名，并定出要聚焦的文件。
/// 打开图片文件时聚焦该图；打开目录且 `restore` 时取最近目录里记下的上次看到的图片。
pub(crate) fn prepare_open(
    path: &Path,
    recursive: bool,
    restore: bool,
    recents: &RecentsState,
) -> Result<(OpenTarget, String, Option<PathBuf>), OpenError> {
    let target = resolve_open_target(path, recursive)?;
    let name = root_display_name(path, &target);
    let focus = match &target.focus_file {
        Some(file) => Some(file.clone()),
        None if restore => restored_focus(&target.root, target.recursive, recents),
        None => None,
    };
    Ok((target, name, focus))
}

/// 最近目录里记下的上次看到的图片；相对路径不合法、文件不在或不是图片时为 None。
/// 非递归打开时只认根目录下的文件（单级名字），子目录里的图不在这次的列表里。
fn restored_focus(root: &Path, recursive: bool, recents: &RecentsState) -> Option<PathBuf> {
    let last = recents.last_of(&root.to_string_lossy())?;
    if !recursive && last.contains('/') {
        return None;
    }
    let mut file = root.to_path_buf();
    for seg in last.split('/') {
        // 只接受普通的单级名字，防止配置文件里的 ".." 等跳出根目录。
        let mut parts = Path::new(seg).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(_)), None) => file.push(seg),
            _ => return None,
        }
    }
    (file.is_file() && is_image_path(&file)).then_some(file)
}

/// 最近目录列表（显示顺序）。会 stat 每一项，不上主线程。
#[tauri::command(async)]
pub fn recents_list(recents: State<'_, RecentsState>) -> Vec<RecentEntry> {
    recents.entries()
}

#[tauri::command(async)]
pub fn recents_pin(
    path: String,
    pinned: bool,
    recents: State<'_, RecentsState>,
) -> Vec<RecentEntry> {
    recents.update(|l| l.pin(&path, pinned));
    recents.entries()
}

#[tauri::command(async)]
pub fn recents_remove(path: String, recents: State<'_, RecentsState>) -> Vec<RecentEntry> {
    recents.update(|l| l.remove(&path));
    recents.entries()
}

/// 前端汇报当前目录的状态：图片数、前几张的缩略图、上次看到的图片、排序与是否含子目录。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn recents_note(
    generation: u32,
    count: u32,
    first: Vec<u32>,
    last: Option<u32>,
    sort: SortKey,
    include_subdirs: bool,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    recents: State<'_, RecentsState>,
) {
    note_recent(
        &registry,
        &sessions,
        &recents,
        generation,
        count,
        &first,
        last,
        sort,
        include_subdirs,
    );
}

/// `generation` 不是当前会话时整条忽略。`first` 只取前 4 个，经登记表换路径，
/// 不在当前根目录下或文件已不在的跳过，其余算 320 档缓存键；`last` 换成相对根目录的路径。
#[allow(clippy::too_many_arguments)]
pub(crate) fn note_recent(
    registry: &Registry,
    sessions: &Sessions,
    recents: &RecentsState,
    generation: u32,
    count: u32,
    first: &[u32],
    last: Option<u32>,
    sort: SortKey,
    include_subdirs: bool,
) {
    let Some((current, root)) = sessions.current() else {
        return;
    };
    if current != generation {
        return;
    }
    let under_root = |id: u32| {
        registry
            .path(FileId(id))
            .filter(|p| p.starts_with(&root) && p != &root)
    };
    let thumbs = first
        .iter()
        .take(RECENT_THUMBS)
        .filter_map(|&id| under_root(id))
        .filter_map(|p| ThumbCache::key_for_file(&p, Tier::S))
        .collect();
    let last = last.and_then(under_root).map(|p| rel_path(&root, &p));
    let note = Note {
        count,
        thumbs,
        last,
        sort,
        include_subdirs,
    };
    recents.update(|l| l.note(&root.to_string_lossy(), note));
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

/// 按 ID 核对对比篮里的文件（可能在当前目录之外），顺序与 `ids` 一致；
/// 未登记、文件不在或不是普通文件的位置为 None。读文件，不上主线程。
#[tauri::command(async)]
pub fn basket_check(
    ids: Vec<u32>,
    registry: State<'_, Arc<Registry>>,
) -> Vec<Option<BasketEntry>> {
    ids.into_iter()
        .map(|id| details::basket_entry(&registry, FileId(id)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::settings::SortKey;
    use std::path::Path;

    /// 规范化的临时目录（macOS 上 /var → /private/var），与会话根目录同一形式。
    fn root_of(tmp: &tempfile::TempDir) -> PathBuf {
        if cfg!(windows) {
            tmp.path().to_path_buf()
        } else {
            std::fs::canonicalize(tmp.path()).unwrap()
        }
    }

    fn png(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"\x89PNG").unwrap();
    }

    /// 已 attach 到 root 的会话，返回代号。
    fn attached(sessions: &Sessions, root: &Path) -> u32 {
        sessions.note(1);
        let (g, _) = sessions.begin(1).unwrap();
        let (tx, _rx) = std::sync::mpsc::channel();
        sessions.attach(g, root.to_path_buf(), tx);
        g
    }

    struct World {
        _tmp: tempfile::TempDir,
        _cfg: tempfile::TempDir,
        root: PathBuf,
        key: String,
        registry: Registry,
        sessions: Sessions,
        recents: RecentsState,
        generation: u32,
    }

    fn world() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tempfile::tempdir().unwrap();
        let root = root_of(&tmp);
        let key = root.to_string_lossy().into_owned();
        let recents = RecentsState::load(cfg.path());
        recents.update(|l| l.touch(&key, "root"));
        let sessions = Sessions::default();
        let generation = attached(&sessions, &root);
        World {
            _tmp: tmp,
            _cfg: cfg,
            root,
            key,
            registry: Registry::default(),
            sessions,
            recents,
            generation,
        }
    }

    impl World {
        fn note(&self, generation: u32, first: &[u32], last: Option<u32>) {
            note_recent(
                &self.registry,
                &self.sessions,
                &self.recents,
                generation,
                7,
                first,
                last,
                SortKey::Mtime,
                true,
            );
        }
        fn entry(&self) -> crate::state::recents::RecentEntry {
            self.recents
                .entries()
                .into_iter()
                .find(|e| e.path == self.key)
                .unwrap()
        }
    }

    #[test]
    fn note_from_an_old_generation_is_ignored() {
        let w = world();
        let a = w.root.join("a.png");
        png(&a);
        let id = w.registry.register(&a).0;
        w.note(w.generation + 1, &[id], Some(id));
        let e = w.entry();
        assert_eq!(e.count, None);
        assert!(e.thumbs.is_empty());
        assert_eq!(w.recents.last_of(&w.key), None);

        w.note(w.generation, &[id], Some(id));
        let e = w.entry();
        assert_eq!(e.count, Some(7));
        assert_eq!(e.sort, Some(SortKey::Mtime));
        assert_eq!(e.include_subdirs, Some(true));
    }

    #[test]
    fn note_skips_ids_outside_the_current_root() {
        let w = world();
        let elsewhere = tempfile::tempdir().unwrap();
        let out = root_of(&elsewhere).join("x.png");
        png(&out);
        let mut ids = vec![w.registry.register(&out).0];
        let mut expected = vec![];
        for i in 0..5 {
            let f = w.root.join(format!("sub/{i}.png"));
            png(&f);
            ids.push(w.registry.register(&f).0);
            expected.push(ThumbCache::key_for_file(&f, Tier::S).unwrap());
        }
        // 已删除的文件与未登记的 id 也跳过
        let gone = w.root.join("gone.png");
        png(&gone);
        let gone_id = w.registry.register(&gone).0;
        std::fs::remove_file(&gone).unwrap();
        // 先取前 4 个再过滤：ids[2] 排在第 5，不算
        w.note(w.generation, &[ids[0], gone_id, 9999, ids[1], ids[2]], None);
        assert_eq!(w.entry().thumbs, expected[..1].to_vec());

        // 只取前 4 个 id
        w.note(w.generation, &ids[1..], None);
        assert_eq!(w.entry().thumbs, expected[..4].to_vec());
        assert!(
            !w.entry()
                .thumbs
                .contains(&ThumbCache::key_for_file(&out, Tier::S).unwrap())
        );
    }

    #[test]
    fn note_stores_last_as_a_relative_slash_path() {
        let w = world();
        let f = w.root.join("a").join("b.png");
        png(&f);
        let id = w.registry.register(&f).0;
        w.note(w.generation, &[], Some(id));
        assert_eq!(w.recents.last_of(&w.key).as_deref(), Some("a/b.png"));
    }

    #[test]
    fn note_with_last_outside_the_root_stores_none() {
        let w = world();
        let f = w.root.join("a.png");
        png(&f);
        let id = w.registry.register(&f).0;
        w.note(w.generation, &[], Some(id));
        assert!(w.recents.last_of(&w.key).is_some());
        let elsewhere = tempfile::tempdir().unwrap();
        let out = root_of(&elsewhere).join("x.png");
        png(&out);
        w.note(w.generation, &[], Some(w.registry.register(&out).0));
        assert_eq!(w.recents.last_of(&w.key), None);
    }

    #[test]
    fn restore_focuses_the_last_seen_image() {
        let w = world();
        let f = w.root.join("a").join("b.png");
        png(&f);
        let id = w.registry.register(&f).0;
        w.note(w.generation, &[], Some(id));
        let (target, _, focus) = prepare_open(&w.root, true, true, &w.recents).unwrap();
        assert_eq!(target.root, w.root);
        let focus = focus.expect("restore 应聚焦上次看到的图");
        assert_eq!(w.registry.register(&focus).0, id);
    }

    #[test]
    fn restore_ignores_a_last_image_that_is_gone() {
        let w = world();
        let f = w.root.join("b.png");
        png(&f);
        w.note(w.generation, &[], Some(w.registry.register(&f).0));
        std::fs::remove_file(&f).unwrap();
        let (_, _, focus) = prepare_open(&w.root, true, true, &w.recents).unwrap();
        assert_eq!(focus, None);
        // 同名的目录也不算
        std::fs::create_dir(&f).unwrap();
        let (_, _, focus) = prepare_open(&w.root, true, true, &w.recents).unwrap();
        assert_eq!(focus, None);
    }

    #[test]
    fn touch_from_a_stale_open_is_dropped() {
        let w = world();
        let other = tempfile::tempdir().unwrap();
        let b = root_of(&other).to_string_lossy().into_owned();
        // 期间又有一次打开：本次（w.generation）的登记已过期
        w.sessions.note(2);
        let (g2, _) = w.sessions.begin(2).unwrap();
        let (tx, _rx) = std::sync::mpsc::channel();
        w.sessions.attach(g2, root_of(&other), tx);
        touch_if_current(&w.sessions, &w.recents, g2, &b, "b");
        touch_if_current(&w.sessions, &w.recents, w.generation, "/stale", "a");
        let paths: Vec<String> = w.recents.entries().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec![b, w.key.clone()]);
    }

    #[test]
    fn non_recursive_restore_accepts_only_a_root_level_image() {
        let w = world();
        let nested = w.root.join("a").join("b.png");
        png(&nested);
        w.note(w.generation, &[], Some(w.registry.register(&nested).0));
        let (_, _, focus) = prepare_open(&w.root, false, true, &w.recents).unwrap();
        assert_eq!(focus, None, "非递归打开时看不到子目录里的图");
        let (_, _, focus) = prepare_open(&w.root, true, true, &w.recents).unwrap();
        assert_eq!(focus, Some(nested));

        let top = w.root.join("top.png");
        png(&top);
        w.note(w.generation, &[], Some(w.registry.register(&top).0));
        let (_, _, focus) = prepare_open(&w.root, false, true, &w.recents).unwrap();
        assert_eq!(focus, Some(top));
    }

    #[test]
    fn restore_rejects_escaping_absolute_and_non_image_lasts() {
        let w = world();
        png(&w.root.join("b.png"));
        png(&w.root.join("a").join("x.png"));
        std::fs::write(w.root.join("notes.txt"), "hi").unwrap();
        let abs = w.root.join("b.png").to_string_lossy().into_owned();
        for bad in ["../x.png", "a/../b.png", abs.as_str(), "notes.txt"] {
            w.recents.update(|l| {
                l.note(
                    &w.key,
                    Note {
                        count: 1,
                        thumbs: vec![],
                        last: Some(bad.to_string()),
                        sort: SortKey::Name,
                        include_subdirs: true,
                    },
                )
            });
            let (_, _, focus) = prepare_open(&w.root, true, true, &w.recents).unwrap();
            assert_eq!(focus, None, "{bad}");
        }
    }

    #[test]
    fn without_restore_a_directory_open_has_no_focus() {
        let w = world();
        let f = w.root.join("b.png");
        png(&f);
        w.note(w.generation, &[], Some(w.registry.register(&f).0));
        let (_, _, focus) = prepare_open(&w.root, true, false, &w.recents).unwrap();
        assert_eq!(focus, None);
        // 打开图片文件时聚焦的仍是那张图，与 restore 无关
        let other = w.root.join("c.png");
        png(&other);
        for restore in [false, true] {
            let (_, _, focus) = prepare_open(&other, true, restore, &w.recents).unwrap();
            assert_eq!(focus, Some(other.clone()));
        }
    }
}
