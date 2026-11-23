//! Glance 图像解码与处理核心库（纯 Rust 接口，不依赖 Tauri）。

mod encode;
mod error;
mod thumb;

pub use encode::{RgbaView, encode_jpeg, encode_png_lossless, encode_webp};
pub use error::ImagingError;
pub use thumb::{Decoded, Thumbnail, decode_rgba, make_thumbnail};
