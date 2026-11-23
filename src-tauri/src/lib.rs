pub mod catalog;
mod commands;
pub mod fileops;
#[cfg(debug_assertions)]
mod lab;
mod protocol;
mod thumbs;

use catalog::registry::Registry;
use catalog::session::Sessions;
use std::sync::Arc;
use tauri::Manager;
use thumbs::{ThumbCache, Thumbs};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .manage(Arc::new(Registry::default()))
        .manage(Sessions::default())
        .setup(|app| {
            let registry = app.state::<Arc<Registry>>().inner().clone();
            let cache = ThumbCache::new(app.path().app_cache_dir()?.join("thumbs"));
            app.manage(Thumbs::start(cache, registry));
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
        lab::lab_register_dir,
        lab::lab_paths,
        lab::lab_protocol_hits,
        lab::lab_trash,
        lab::lab_restore
    ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_path,
        commands::thumbs_subscribe,
        commands::thumbs_want,
        commands::image_details
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
