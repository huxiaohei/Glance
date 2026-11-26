//! 编辑（压缩、转格式）：会话持有解码好的原图与代理图，预览在每会话一条的线程上只算最新请求，
//! 结果经 `glance://edit/{会话}/{版本}` 交给前端。前端只见会话号与版本号，不见路径。

pub mod commands;
pub mod render;
mod session;
mod worker;

pub use session::{EditError, EditOpened, EditState, PreviewResult};
