pub mod catalog;
mod basket;
mod batch;
mod commands;
pub mod decode;
mod dragout;
pub mod edit;
pub mod fileops;
#[cfg(debug_assertions)]
mod lab;
#[cfg(target_os = "macos")]
mod macos_service;
pub mod protocol;
mod shell;
mod state;
mod system;
pub mod thumbs;
mod update;

use catalog::registry::Registry;
use catalog::session::Sessions;
use fileops::commands::RecentTargets;
use fileops::undo::UndoLog;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;
use thumbs::{ThumbCache, Thumbs};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            match shell::pick_target(&argv, Path::new(&cwd)) {
                Some(path) => shell::submit(app, path),
                None => shell::bring_to_front(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                )
                .build(),
        );
    // 公钥填占位串时插件照常注册：公钥只在校验下载包签名时才解码。
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let builder = builder
        .manage(Arc::new(Registry::default()))
        .manage(Arc::new(edit::EditState::default()))
        .manage(update::PendingUpdate::default())
        .manage(Sessions::default())
        .manage(UndoLog::default())
        .manage(batch::job::BatchState::default())
        .manage(shell::OpenRequests::default())
        .setup(|app| {
            // 启动参数只记下，不发事件：前端挂载后主动取。
            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            if let Some(path) = shell::pick_target(&argv, &cwd) {
                app.state::<shell::OpenRequests>().put(&path);
            }
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
            let session_store = Arc::new(state::session::SessionStore::load(
                &app.path().app_config_dir()?,
            ));
            app.manage(RecentTargets::new(session_store.clone()));
            app.manage(session_store);
            app.manage(state::recents::RecentsState::load(
                &app.path().app_config_dir()?,
            ));
            state::settings::apply_window_theme(app.handle(), theme);
            #[cfg(target_os = "macos")]
            macos_service::install(app.handle());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("glance", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            // 读文件不得占用主线程。
            tauri::async_runtime::spawn_blocking(move || {
                let registry = app.state::<Arc<Registry>>();
                let thumbs = app.state::<Arc<Thumbs>>();
                let edit = app.state::<Arc<edit::EditState>>();
                let ctx = protocol::Ctx::new(&registry, thumbs.cache(), &edit);
                responder.respond(protocol::respond(&ctx, &path));
            });
        });

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_path,
        commands::thumbs_subscribe,
        commands::thumbs_want,
        commands::image_details,
        commands::basket_check,
        commands::image_status,
        basket::basket_save,
        basket::basket_restore,
        basket::browse_dir,
        batch::plan::batch_plan,
        batch::job::batch_start,
        batch::job::batch_cancel,
        commands::recents_list,
        commands::recents_pin,
        commands::recents_remove,
        commands::recents_note,
        shell::take_open_request,
        update::update_check,
        update::update_install,
        fileops::commands::fs_trash,
        fileops::commands::fs_rename,
        fileops::commands::fs_move,
        fileops::commands::fs_copy,
        fileops::commands::fs_undo,
        fileops::commands::fs_recent_targets,
        system::clipboard_copy_image,
        system::clipboard_copy_paths,
        system::reveal,
        system::open_codec_help,
        dragout::drag_out,
        edit::commands::edit_open,
        edit::commands::edit_preview,
        edit::commands::edit_pick,
        edit::commands::edit_close,
        edit::commands::edit_save,
        edit::commands::edit_params_get,
        edit::commands::edit_params_set,
        state::settings::settings_get,
        state::settings::settings_set,
        lab::lab_register_dir,
        lab::lab_protocol_hits,
        lab::lab_trash,
        lab::lab_restore,
        lab::lab_heic_probe
    ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_path,
        commands::thumbs_subscribe,
        commands::thumbs_want,
        commands::image_details,
        commands::basket_check,
        commands::image_status,
        basket::basket_save,
        basket::basket_restore,
        basket::browse_dir,
        batch::plan::batch_plan,
        batch::job::batch_start,
        batch::job::batch_cancel,
        commands::recents_list,
        commands::recents_pin,
        commands::recents_remove,
        commands::recents_note,
        shell::take_open_request,
        update::update_check,
        update::update_install,
        fileops::commands::fs_trash,
        fileops::commands::fs_rename,
        fileops::commands::fs_move,
        fileops::commands::fs_copy,
        fileops::commands::fs_undo,
        fileops::commands::fs_recent_targets,
        system::clipboard_copy_image,
        system::clipboard_copy_paths,
        system::reveal,
        system::open_codec_help,
        dragout::drag_out,
        edit::commands::edit_open,
        edit::commands::edit_preview,
        edit::commands::edit_pick,
        edit::commands::edit_close,
        edit::commands::edit_save,
        edit::commands::edit_params_get,
        edit::commands::edit_params_set,
        state::settings::settings_get,
        state::settings::settings_set
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            {
                let target = match _event {
                    tauri::RunEvent::Opened { urls } => shell::url_target(&urls),
                    _ => None,
                };
                if let Some(path) = target {
                    shell::submit(_app, path);
                }
            }
        });
}
