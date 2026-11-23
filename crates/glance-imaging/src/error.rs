/// 图像编码/处理错误。
#[derive(Debug, thiserror::Error)]
pub enum ImagingError {
    #[error("图片尺寸无效：{width}×{height}，数据长度 {len}")]
    InvalidBuffer { width: u32, height: u32, len: usize },
    #[error("质量必须在 1 到 100 之间，实际 {0}")]
    InvalidQuality(u8),
    #[error("编码失败：{0}")]
    Encode(String),
    #[error("无法解码图片：{0}")]
    Decode(String),
    #[error("缩略图边长必须大于 0")]
    InvalidMaxEdge,
    #[error("图片像素数超过上限")]
    TooLarge,
}
