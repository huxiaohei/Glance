//! 用户设置：`<配置目录>/settings.json`。
use super::store;
use crate::fileops::fsx;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CompareBackground {
    #[default]
    Dark,
    Light,
    Checker,
}

/// 编辑完成后的默认保存方式：存副本，或覆盖原图。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EditSaveMode {
    #[default]
    Copy,
    Overwrite,
}

/// 批量输出目录名的默认值。
pub const DEFAULT_BATCH_DIR: &str = "_glance_output";
#[allow(dead_code)] // 任务 3 起由批量压缩使用
const BATCH_DIR_MAX_CHARS: usize = 64;

#[allow(dead_code)]
fn valid_batch_dir(name: &str) -> bool {
    fsx::validate_name(name).is_ok()
        && !name.contains(':')
        && name.chars().count() <= BATCH_DIR_MAX_CHARS
}

/// 批量输出目录名：去首尾空白后合法就用它，否则退回默认值。
#[allow(dead_code)]
pub fn batch_dir_name(s: &Settings) -> String {
    let name = s.batch_output_dir.trim();
    if valid_batch_dir(name) {
        name.to_string()
    } else {
        DEFAULT_BATCH_DIR.to_string()
    }
}

pub const COMPARE_COLUMNS_MIN: u8 = 2;
pub const COMPARE_COLUMNS_MAX: u8 = 8;

impl Settings {
    /// 把越界的值夹回合法范围。
    fn clamped(mut self) -> Self {
        self.compare_columns = self
            .compare_columns
            .clamp(COMPARE_COLUMNS_MIN, COMPARE_COLUMNS_MAX);
        self
    }
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
    /// 启动时检查更新（仅正式构建）。
    pub check_updates: bool,
    /// 对比视图每排张数，2..=8。
    pub compare_columns: u8,
    /// 进入对比时是否开启同步缩放。
    pub compare_sync_on_enter: bool,
    pub compare_background: CompareBackground,
    /// 在底部给出按当前状态预测的快捷键提示。
    pub show_key_hints: bool,
    /// 编辑面板的默认保存方式。
    pub edit_save_mode: EditSaveMode,
    /// 批量压缩 / 转格式的输出子目录名。
    pub batch_output_dir: String,
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
            check_updates: true,
            compare_columns: 4,
            compare_sync_on_enter: true,
            compare_background: CompareBackground::Dark,
            show_key_hints: true,
            edit_save_mode: EditSaveMode::Copy,
            batch_output_dir: DEFAULT_BATCH_DIR.to_string(),
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
        let current = Mutex::new(store::load::<Settings>(&path).clamped());
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
        let next = next.clamped();
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
    fn old_settings_default_copy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"light"}"#).unwrap();
        let s = SettingsState::load(dir.path()).get();
        assert_eq!(s.edit_save_mode, EditSaveMode::Copy);
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap()["editSaveMode"],
            "copy"
        );
        let o: Settings = serde_json::from_str(r#"{"editSaveMode":"overwrite"}"#).unwrap();
        assert_eq!(o.edit_save_mode, EditSaveMode::Overwrite);
    }

    #[test]
    fn batch_dir_defaults_and_sanitizes() {
        let old: Settings = serde_json::from_str(r#"{"theme":"light"}"#).unwrap();
        assert_eq!(old.batch_output_dir, "_glance_output");
        assert_eq!(batch_dir_name(&old), "_glance_output");
        let with = |n: &str| Settings {
            batch_output_dir: n.to_string(),
            ..Settings::default()
        };
        assert_eq!(batch_dir_name(&with("  out  ")), "out");
        let long = "a".repeat(65);
        for bad in ["a/b", "..", "", "   ", "con", "a:b", long.as_str()] {
            assert_eq!(batch_dir_name(&with(bad)), DEFAULT_BATCH_DIR, "{bad:?}");
        }
        assert_eq!(batch_dir_name(&with(&"a".repeat(64))), "a".repeat(64));
    }

    #[test]
    fn defaults_match_the_spec() {
        let d = Settings::default();
        assert_eq!(d.theme, Theme::Dark);
        assert_eq!(d.language, Language::System);
        assert!(d.include_subdirs);
        assert_eq!(d.default_sort, SortKey::Name);
        assert!(!d.loop_at_end);
        assert_eq!(d.wheel, WheelAction::Zoom);
        assert!(d.check_updates);
    }

    #[test]
    fn old_settings_file_without_check_updates_reads_as_true() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"theme":"light","includeSubdirs":false,"defaultSort":"size","loopAtEnd":true,"wheel":"switch","language":"en"}"#,
        )
        .unwrap();
        let s = SettingsState::load(dir.path()).get();
        assert!(s.check_updates);
        assert_eq!(s.theme, Theme::Light);
    }

    #[test]
    fn check_updates_false_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let st = SettingsState::load(dir.path());
        let next = Settings {
            check_updates: false,
            ..Settings::default()
        };
        st.set(next.clone()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(
            text.contains(r#""checkUpdates":false"#) || text.contains(r#""checkUpdates": false"#)
        );
        assert_eq!(SettingsState::load(dir.path()).get(), next);
    }

    #[test]
    fn wire_shape_is_camel_case() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({"theme":"dark","language":"system","includeSubdirs":true,
                   "defaultSort":"name","loopAtEnd":false,"wheel":"zoom","checkUpdates":true,
                   "compareColumns":4,"compareSyncOnEnter":true,"compareBackground":"dark",
                   "showKeyHints":true,"editSaveMode":"copy",
                   "batchOutputDir":"_glance_output"})
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

    #[test]
    fn old_settings_file_gets_compare_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"theme":"light","includeSubdirs":false,"defaultSort":"size","loopAtEnd":true,"wheel":"switch","language":"en"}"#,
        )
        .unwrap();
        let s = SettingsState::load(dir.path()).get();
        assert_eq!(s.compare_columns, 4);
        assert!(s.compare_sync_on_enter);
        assert_eq!(s.compare_background, CompareBackground::Dark);
    }

    #[test]
    fn old_settings_file_without_show_key_hints_reads_as_true() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"theme":"light","compareColumns":3,"compareSyncOnEnter":false}"#,
        )
        .unwrap();
        let s = SettingsState::load(dir.path()).get();
        assert!(s.show_key_hints);
        assert_eq!(s.compare_columns, 3);
    }

    #[test]
    fn show_key_hints_false_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let st = SettingsState::load(dir.path());
        let next = Settings {
            show_key_hints: false,
            ..Settings::default()
        };
        st.set(next.clone()).unwrap();
        assert_eq!(SettingsState::load(dir.path()).get(), next);
    }

    #[test]
    fn compare_columns_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let st = SettingsState::load(dir.path());
        for (written, read) in [(1u8, 2u8), (99, 8), (5, 5)] {
            st.set(Settings {
                compare_columns: written,
                ..Settings::default()
            })
            .unwrap();
            assert_eq!(st.get().compare_columns, read);
            assert_eq!(SettingsState::load(dir.path()).get().compare_columns, read);
        }
        // 文件里手写了越界值，加载时也夹取
        std::fs::write(dir.path().join("settings.json"), r#"{"compareColumns":0}"#).unwrap();
        assert_eq!(SettingsState::load(dir.path()).get().compare_columns, 2);
    }
}
