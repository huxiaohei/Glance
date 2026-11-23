//! 会话状态：`<配置目录>/session.json`。目前只有最近的移动 / 复制目标。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionFile {
    pub recent_targets: Vec<String>,
}
