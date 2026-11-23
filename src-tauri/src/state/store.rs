//! 配置文件的原子读写：读不出一律退回默认值；写先落同目录临时文件再改名。
use serde::{Serialize, de::DeserializeOwned};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 文件不存在、读不出、解析失败都返回 `T::default()`。
pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 按需建父目录；写临时文件、`sync_all`、改名替换目标；失败时删掉临时文件。
pub fn save<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(parent) = parent {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?
        .to_string_lossy();
    let tmp_name = format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let tmp = match parent {
        Some(p) => p.join(tmp_name),
        None => tmp_name.into(),
    };
    let write = || -> std::io::Result<()> {
        let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    let result = write();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::settings::Settings;

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let s: Settings = load(&dir.path().join("nope.json"));
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn garbage_and_empty_files_load_default() {
        let dir = tempfile::tempdir().unwrap();
        for (i, body) in ["", "{", "[1,2]"].iter().enumerate() {
            let p = dir.path().join(format!("g{i}.json"));
            std::fs::write(&p, body).unwrap();
            let s: Settings = load(&p);
            assert_eq!(s, Settings::default(), "body {body:?}");
        }
    }

    #[test]
    fn save_then_load_roundtrips_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let v = Settings {
            loop_at_end: true,
            ..Settings::default()
        };
        save(&p, &v).unwrap();
        assert_eq!(load::<Settings>(&p), v);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
    }

    #[test]
    fn save_creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a/b/settings.json");
        save(&p, &Settings::default()).unwrap();
        assert!(p.exists());
    }

    #[test]
    fn save_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        save(&p, &Settings::default()).unwrap();
        let v = Settings {
            loop_at_end: true,
            ..Settings::default()
        };
        save(&p, &v).unwrap();
        assert_eq!(load::<Settings>(&p), v);
    }

    #[test]
    fn save_failing_at_rename_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        // 目标位置是个非空目录：临时文件写得出来，改名替换会失败
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("keep"), b"x").unwrap();
        assert!(save(&p, &Settings::default()).is_err());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
        assert!(p.is_dir());
    }
}
