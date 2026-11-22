//! Glance 图像解码与处理核心库（纯 Rust 接口，不依赖 Tauri）。

mod encode;
mod error;

pub use encode::{RgbaView, encode_jpeg, encode_png_lossless, encode_webp};
pub use error::ImagingError;
