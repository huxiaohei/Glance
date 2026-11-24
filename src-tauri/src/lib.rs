pub mod catalog;
mod commands;
mod dragout;
pub mod fileops;
#[cfg(debug_assertions)]
mod lab;
mod protocol;
mod state;
mod system;
mod thumbs;

use catalog::registry::Registry;
use catalog::session::Sessions;
use fileops::commands::RecentTargets;
use fileops::undo::UndoLog;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;
use thumbs::{ThumbCache, Thumbs};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(Arc::new(Registry::default()))
        .manage(Sessions::default())
        .manage(UndoLog::default())
        .setup(|app| {
            let registry = app.state::<Arc<Registry>>().inner().clone();
            let cache = ThumbCache::new(app.path().app_cache_dir()?.join("thumbs"));
            let cache_dir = cache.dir().to_path_buf();
            // 起不来就跳过，不影响启动。
            let _ = std::thread::Builder::new()
                .name("glance-cache-sweep".into())
                .spawn(move || {
                    thumbs::sweep::sweep(
                        &cache_dir,
                        thumbs::sweep::CACHE_LIMIT,
                        thumbs::sweep::CACHE_TARGET,
                        std::time::SystemTime::now(),
                    );
                });
            app.manage(Thumbs::start(cache, registry));
            let settings = state::settings::SettingsState::load(&app.path().app_config_dir()?);
            let theme = settings.get().theme;
            app.manage(settings);
            app.manage(RecentTargets::load(&app.path().app_config_dir()?));
            app.manage(state::recents::RecentsState::load(
                &app.path().app_config_dir()?,
            ));
            state::settings::apply_window_theme(app.handle(), theme);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("glance", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            // 读文件不得占用主线程。
            tauri::async_runtime::spawn_blocking(move || {
                let registry = app.state::<Arc<Registry>>();
                let thumbs = app.state::<Arc<Thumbs>>();
                let ctx = protocol::Ctx {
                    registry: &registry,
                    thumbs: thumbs.cache(),
                };
                responder.respond(protocol::respond(&ctx, &path));
            });
        });

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_path,
        commands::thumbs_subscribe,
        commands::thumbs_want,
        commands::image_details,
        commands::recents_list,
        commands::recents_pin,
        commands::recents_remove,
        commands::recents_note,
        fileops::commands::fs_trash,
        fileops::commands::fs_rename,
        fileops::commands::fs_move,
        fileops::commands::fs_copy,
        fileops::commands::fs_undo,
        fileops::commands::fs_recent_targets,
        system::clipboard_copy_image,
        system::clipboard_copy_paths,
        system::reveal,
        dragout::drag_out,
        state::settings::settings_get,
        state::settings::settings_set,
        lab::lab_register_dir,
        lab::lab_protocol_hits,
        lab::lab_trash,
        lab::lab_restore
    ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_path,
        commands::thumbs_subscribe,
        commands::thumbs_want,
        commands::image_details,
        commands::recents_list,
        commands::recents_pin,
        commands::recents_remove,
        commands::recents_note,
        fileops::commands::fs_trash,
        fileops::commands::fs_rename,
        fileops::commands::fs_move,
        fileops::commands::fs_copy,
        fileops::commands::fs_undo,
        fileops::commands::fs_recent_targets,
        system::clipboard_copy_image,
        system::clipboard_copy_paths,
        system::reveal,
        dragout::drag_out,
        state::settings::settings_get,
        state::settings::settings_set
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
