//! 用户设置：`<配置目录>/settings.json`。
use super::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Language {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    #[default]
    Name,
    Mtime,
    Size,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WheelAction {
    #[default]
    Zoom,
    Switch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub language: Language,
    pub include_subdirs: bool,
    pub default_sort: SortKey,
    pub loop_at_end: bool,
    pub wheel: WheelAction,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            language: Language::System,
            include_subdirs: true,
            default_sort: SortKey::Name,
            loop_at_end: false,
            wheel: WheelAction::Zoom,
        }
    }
}

pub struct SettingsState {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsState {
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("settings.json");
        let current = Mutex::new(store::load(&path));
        Self { path, current }
    }

    pub fn get(&self) -> Settings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 持锁写盘再换内存值：并发调用串行化；写盘失败时内存值不变。
    pub fn set(&self, next: Settings) -> std::io::Result<()> {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        store::save(&self.path, &next)?;
        *cur = next;
        Ok(())
    }
}

/// 把主窗口主题设为设置里的值；找不到窗口就跳过。
pub fn apply_window_theme<R: tauri::Runtime>(app: &impl Manager<R>, theme: Theme) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let t = match theme {
        Theme::Dark => Some(tauri::Theme::Dark),
        Theme::Light => Some(tauri::Theme::Light),
        Theme::System => None,
    };
    let _ = win.set_theme(t);
}

#[tauri::command(async)]
pub fn settings_get(state: State<'_, SettingsState>) -> Settings {
    state.get()
}

#[tauri::command(async)]
pub fn settings_set(
    app: tauri::AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    let theme = settings.theme;
    state.set(settings).map_err(|_| "saveFailed".to_string())?;
    apply_window_theme(&app, theme);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn defaults_match_the_spec() {
        let d = Settings::default();
        assert_eq!(d.theme, Theme::Dark);
        assert_eq!(d.language, Language::System);
        assert!(d.include_subdirs);
        assert_eq!(d.default_sort, SortKey::Name);
        assert!(!d.loop_at_end);
        assert_eq!(d.wheel, WheelAction::Zoom);
    }

    #[test]
    fn wire_shape_is_camel_case() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({"theme":"dark","language":"system","includeSubdirs":true,
                   "defaultSort":"name","loopAtEnd":false,"wheel":"zoom"})
        );
    }

    #[test]
    fn language_values_are_system_zh_cn_en() {
        for (l, s) in [
            (Language::System, "system"),
            (Language::ZhCn, "zh-CN"),
            (Language::En, "en"),
        ] {
            assert_eq!(serde_json::to_value(l).unwrap(), json!(s));
            assert_eq!(serde_json::from_value::<Language>(json!(s)).unwrap(), l);
        }
    }

    #[test]
    fn missing_fields_take_defaults_and_unknown_fields_are_ignored() {
        let s: Settings = serde_json::from_value(json!({"theme":"light","futureThing":1})).unwrap();
        assert_eq!(
            s,
            Settings {
                theme: Theme::Light,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn unknown_enum_value_falls_back_to_all_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"theme":"sepia","loopAtEnd":true}"#,
        )
        .unwrap();
        assert_eq!(SettingsState::load(dir.path()).get(), Settings::default());
    }

    #[test]
    fn set_persists_and_get_returns_it() {
        let dir = tempfile::tempdir().unwrap();
        let st = SettingsState::load(dir.path());
        let next = Settings {
            theme: Theme::Light,
            language: Language::En,
            loop_at_end: true,
            ..Settings::default()
        };
        st.set(next.clone()).unwrap();
        assert_eq!(st.get(), next);
        assert_eq!(SettingsState::load(dir.path()).get(), next);
    }

    #[test]
    fn concurrent_sets_leave_one_complete_value() {
        let dir = tempfile::tempdir().unwrap();
        let st = Arc::new(SettingsState::load(dir.path()));
        let sorts = [SortKey::Name, SortKey::Mtime, SortKey::Size];
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let st = st.clone();
                std::thread::spawn(move || {
                    st.set(Settings {
                        theme: [Theme::Dark, Theme::Light, Theme::System][i % 3],
                        default_sort: sorts[i % 3],
                        loop_at_end: i % 2 == 0,
                        include_subdirs: i % 4 != 0,
                        ..Settings::default()
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(SettingsState::load(dir.path()).get(), st.get());
    }

    #[test]
    fn set_that_fails_to_write_returns_err_and_keeps_the_old_value() {
        let cfg = tempfile::tempdir().unwrap();
        let st = SettingsState::load(cfg.path());
        let before = st.get();
        let file = cfg.path().join("settings.json");
        std::fs::create_dir(&file).unwrap();
        std::fs::write(file.join("keep"), b"x").unwrap();
        let next = Settings {
            loop_at_end: !before.loop_at_end,
            ..before.clone()
        };
        assert!(st.set(next).is_err());
        assert_eq!(st.get(), before);
    }
}
