//! 会话状态：`<配置目录>/session.json`。有最近的移动 / 复制目标与对比篮。
//! 整个文件只由 `SessionStore` 写：各字段的持有者都经它改，免得互相覆盖。
use glance_imaging::{OutFormat, PngMode};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::store;

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionFile {
    pub recent_targets: Vec<String>,
    pub basket: Vec<String>,
    pub edit_params: EditParamsMemory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditTab {
    Compress,
    Convert,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressMemory {
    pub quality: u8,
    pub max_edge_on: bool,
    pub max_edge: u32,
    pub png_mode: PngMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertMemory {
    pub format: OutFormat,
    pub quality: u8,
    pub fill: [u8; 3],
}

/// 编辑面板上次用的参数（压缩 / 转格式两页各记一份）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditParamsMemory {
    pub tab: EditTab,
    pub compress: CompressMemory,
    pub convert: ConvertMemory,
}

impl Default for CompressMemory {
    fn default() -> Self {
        Self {
            quality: 80,
            max_edge_on: false,
            max_edge: 2048,
            png_mode: PngMode::Lossy,
        }
    }
}

impl Default for ConvertMemory {
    fn default() -> Self {
        Self {
            format: OutFormat::Jpeg,
            quality: 85,
            fill: [255, 255, 255],
        }
    }
}

impl Default for EditParamsMemory {
    fn default() -> Self {
        Self {
            tab: EditTab::Compress,
            compress: CompressMemory::default(),
            convert: ConvertMemory::default(),
        }
    }
}

/// 取对象里的一个字段并按类型解析；缺失、类型不对或没通过 `valid` 都回落默认。
fn field<T: serde::de::DeserializeOwned>(
    obj: Option<&Value>,
    key: &str,
    default: T,
    valid: impl Fn(&T) -> bool,
) -> T {
    obj.and_then(|o| o.get(key))
        .and_then(|v| serde_json::from_value::<T>(v.clone()).ok())
        .filter(|v| valid(v))
        .unwrap_or(default)
}

fn quality_ok(q: &u8) -> bool {
    (1..=100).contains(q)
}

impl<'de> Deserialize<'de> for CompressMemory {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let o = Some(&v);
        let def = Self::default();
        Ok(Self {
            quality: field(o, "quality", def.quality, quality_ok),
            max_edge_on: field(o, "maxEdgeOn", def.max_edge_on, |_| true),
            max_edge: field(o, "maxEdge", def.max_edge, |e| (1..=65535).contains(e)),
            png_mode: field(o, "pngMode", def.png_mode, |_| true),
        })
    }
}

impl<'de> Deserialize<'de> for ConvertMemory {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let o = Some(&v);
        let def = Self::default();
        Ok(Self {
            format: field(o, "format", def.format, |_| true),
            quality: field(o, "quality", def.quality, quality_ok),
            fill: field(o, "fill", def.fill, |_| true),
        })
    }
}

impl<'de> Deserialize<'de> for EditParamsMemory {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let o = Some(&v);
        let def = Self::default();
        Ok(Self {
            tab: field(o, "tab", def.tab, |_| true),
            compress: field(o, "compress", def.compress, |_| true),
            convert: field(o, "convert", def.convert, |_| true),
        })
    }
}

/// `session.json` 的内存副本与唯一写入方；没有落盘路径时只在内存里。
#[derive(Default)]
pub struct SessionStore {
    file: Mutex<SessionFile>,
    path: Option<PathBuf>,
}

impl SessionStore {
    /// 读 `<config_dir>/session.json`；读不出就是空。
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("session.json");
        Self {
            file: Mutex::new(store::load(&path)),
            path: Some(path),
        }
    }

    /// 不落盘，测试用。
    pub fn memory() -> Self {
        Self::default()
    }

    pub fn recent_targets(&self) -> Vec<String> {
        self.lock().recent_targets.clone()
    }

    pub fn set_recent_targets(&self, v: Vec<String>) {
        self.update(|f| f.recent_targets = v);
    }

    pub fn basket(&self) -> Vec<String> {
        self.lock().basket.clone()
    }

    pub fn set_basket(&self, v: Vec<String>) {
        self.update(|f| f.basket = v);
    }

    pub fn edit_params(&self) -> EditParamsMemory {
        self.lock().edit_params.clone()
    }

    pub fn set_edit_params(&self, p: EditParamsMemory) {
        self.update(|f| f.edit_params = p);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SessionFile> {
        self.file.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 锁内改字段后整体写盘；写失败静默。
    fn update(&self, change: impl FnOnce(&mut SessionFile)) {
        let mut file = self.lock();
        change(&mut file);
        if let Some(path) = &self.path {
            let _ = store::save(path, &*file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_file_without_basket_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session.json"),
            r#"{"recentTargets":["/a"]}"#,
        )
        .unwrap();
        let s = SessionStore::load(dir.path());
        assert!(s.basket().is_empty());
        assert_eq!(s.recent_targets(), vec!["/a".to_string()]);
    }

    #[test]
    fn set_basket_keeps_recent_targets() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::load(dir.path());
        s.set_recent_targets(vec!["/a".into()]);
        s.set_basket(vec!["/x.png".into()]);
        let again = SessionStore::load(dir.path());
        assert_eq!(again.recent_targets(), vec!["/a".to_string()]);
        assert_eq!(again.basket(), vec!["/x.png".to_string()]);
    }

    #[test]
    fn memory_store_does_not_touch_the_disk() {
        let s = SessionStore::memory();
        s.set_basket(vec!["/x.png".into()]);
        assert_eq!(s.basket(), vec!["/x.png".to_string()]);
        assert!(s.path.is_none());
    }

    #[test]
    fn edit_params_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::load(dir.path());
        let p = EditParamsMemory {
            tab: EditTab::Convert,
            compress: CompressMemory {
                quality: 55,
                max_edge_on: true,
                max_edge: 1024,
                png_mode: PngMode::Lossless,
            },
            convert: ConvertMemory {
                format: OutFormat::Webp,
                quality: 70,
                fill: [1, 2, 3],
            },
        };
        s.set_edit_params(p.clone());
        assert_eq!(SessionStore::load(dir.path()).edit_params(), p);
    }

    #[test]
    fn edit_params_does_not_clobber_basket() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::load(dir.path());
        s.set_recent_targets(vec!["/a".into()]);
        s.set_basket(vec!["/x.png".into()]);
        s.set_edit_params(EditParamsMemory {
            tab: EditTab::Convert,
            ..Default::default()
        });
        s.set_basket(vec!["/y.png".into()]);
        let again = SessionStore::load(dir.path());
        assert_eq!(again.recent_targets(), vec!["/a".to_string()]);
        assert_eq!(again.basket(), vec!["/y.png".to_string()]);
        assert_eq!(again.edit_params().tab, EditTab::Convert);
    }

    #[test]
    fn old_session_json_without_edit_params_loads_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session.json"),
            r#"{"recentTargets":["/a"],"basket":["/b"]}"#,
        )
        .unwrap();
        let s = SessionStore::load(dir.path());
        assert_eq!(s.edit_params(), EditParamsMemory::default());
        assert_eq!(s.basket(), vec!["/b".to_string()]);
    }

    #[test]
    fn invalid_fields_fall_back_individually() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session.json"),
            r#"{"basket":["/b"],"editParams":{"tab":"convert",
              "compress":{"quality":101,"maxEdgeOn":true,"maxEdge":70000,"pngMode":"bogus"},
              "convert":{"format":"webp","quality":0,"fill":[1,2,3]}}}"#,
        )
        .unwrap();
        let p = SessionStore::load(dir.path()).edit_params();
        assert_eq!(p.tab, EditTab::Convert);
        assert_eq!(p.compress.quality, 80);
        assert!(p.compress.max_edge_on);
        assert_eq!(p.compress.max_edge, 2048);
        assert_eq!(p.compress.png_mode, PngMode::Lossy);
        assert_eq!(p.convert.format, OutFormat::Webp);
        assert_eq!(p.convert.quality, 85);
        assert_eq!(p.convert.fill, [1, 2, 3]);
        let z: EditParamsMemory =
            serde_json::from_str(r#"{"compress":{"maxEdge":0},"convert":"junk"}"#).unwrap();
        assert_eq!(z.compress.max_edge, 2048);
        assert_eq!(z.convert, ConvertMemory::default());
    }

    #[test]
    fn edit_params_default_json_shape() {
        let v = serde_json::to_value(EditParamsMemory::default()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"tab":"compress","compress":{"quality":80,"maxEdgeOn":false,"maxEdge":2048,"pngMode":"lossy"},"convert":{"format":"jpeg","quality":85,"fill":[255,255,255]}})
        );
    }
}
