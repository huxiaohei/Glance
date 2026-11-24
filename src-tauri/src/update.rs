//! 应用更新（后端）：检查与安装都在 Rust 里完成，前端只拿到版本号。
use crate::state::settings::SettingsState;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code")]
pub enum UpdateError {
    #[serde(rename = "updateFailed")]
    Failed,
}

/// 检查到的那一份更新；特性关掉时是空壳。
#[derive(Default)]
pub struct PendingUpdate {
    #[cfg(feature = "updater")]
    slot: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
}

/// 调试构建不检查；设置里关了也不检查。
pub fn should_check(debug: bool, enabled: bool) -> bool {
    !debug && enabled
}

/// 有新版本就存起来并返回版本号；其余情况（含任何错误）一律 `None`。
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<String>, ()> {
    Ok(check(&app, &pending).await)
}

#[cfg(feature = "updater")]
async fn check(app: &AppHandle, pending: &PendingUpdate) -> Option<String> {
    use tauri_plugin_updater::UpdaterExt;
    let enabled = app.state::<SettingsState>().get().check_updates;
    if !should_check(cfg!(debug_assertions), enabled) {
        return None;
    }
    let update = app.updater().ok()?.check().await.ok()??;
    let version = update.version.clone();
    *pending.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
    Some(version)
}

#[cfg(not(feature = "updater"))]
async fn check(app: &AppHandle, _pending: &PendingUpdate) -> Option<String> {
    let enabled = app.state::<SettingsState>().get().check_updates;
    let _ = should_check(cfg!(debug_assertions), enabled);
    None
}

/// 下载并安装存着的更新，成功后重启。没有存着的或中途失败：`UpdateError::Failed`。
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), UpdateError> {
    install(&app, &pending).await
}

#[cfg(feature = "updater")]
async fn install(app: &AppHandle, pending: &PendingUpdate) -> Result<(), UpdateError> {
    let update = pending
        .slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or(UpdateError::Failed)?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| UpdateError::Failed)?;
    app.restart()
}

#[cfg(not(feature = "updater"))]
async fn install(_app: &AppHandle, _pending: &PendingUpdate) -> Result<(), UpdateError> {
    Err(UpdateError::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_release_build_with_setting_on_checks() {
        for (debug, enabled, want) in [
            (false, true, true),
            (false, false, false),
            (true, true, false),
            (true, false, false),
        ] {
            assert_eq!(should_check(debug, enabled), want, "({debug},{enabled})");
        }
    }

    #[test]
    fn failed_serializes_to_update_failed_code() {
        assert_eq!(
            serde_json::to_string(&UpdateError::Failed).unwrap(),
            r#"{"code":"updateFailed"}"#
        );
    }
}
