mod catalog;
pub mod fileops;
#[cfg(debug_assertions)]
mod lab;
mod protocol;

use catalog::registry::Registry;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Registry::default())
        .register_asynchronous_uri_scheme_protocol("glance", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            // 读文件不得占用主线程。
            tauri::async_runtime::spawn_blocking(move || {
                let registry = app.state::<Registry>();
                responder.respond(protocol::respond(&registry, &path));
            });
        });

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        lab::lab_register_dir,
        lab::lab_protocol_hits,
        lab::lab_trash,
        lab::lab_restore
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
