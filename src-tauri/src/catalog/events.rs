//! 打开目录时推给前端的事件与返回值。序列化形状是前后端的契约。

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u32,
    /// 相对根目录，一律用 `/` 分隔。
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dim {
    pub id: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CatalogEvent {
    Batch { generation: u32, entries: Vec<Entry> },
    Done { generation: u32, total: usize },
    Dims { generation: u32, items: Vec<Dim> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub generation: u32,
    /// 根目录绝对路径，仅用于显示和重新打开。
    pub path: String,
    pub name: String,
    pub recursive: bool,
    /// 打开的是图片文件时，该图的 FileId。
    pub focus: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum OpenError {
    NotFound,
    NotAnImage,
    Unreadable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_to_the_agreed_shape() {
        let e = CatalogEvent::Batch {
            generation: 3,
            entries: vec![Entry {
                id: 7,
                rel_path: "蜀国/赵云.png".into(),
                size: 12,
                mtime_ms: 1700000000000,
            }],
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"type":"batch","generation":3,"entries":[{"id":7,"relPath":"蜀国/赵云.png","size":12,"mtimeMs":1700000000000}]}"#
        );
        assert_eq!(
            serde_json::to_string(&CatalogEvent::Done { generation: 3, total: 1 }).unwrap(),
            r#"{"type":"done","generation":3,"total":1}"#
        );
        assert_eq!(
            serde_json::to_string(&CatalogEvent::Dims {
                generation: 3,
                items: vec![Dim { id: 7, w: 4, h: 2 }]
            })
            .unwrap(),
            r#"{"type":"dims","generation":3,"items":[{"id":7,"w":4,"h":2}]}"#
        );
        assert_eq!(
            serde_json::to_string(&OpenError::NotAnImage).unwrap(),
            r#"{"code":"notAnImage"}"#
        );
    }
}
