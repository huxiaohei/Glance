//! Glance 图像解码与处理核心库（纯 Rust 接口，不依赖 Tauri）。

mod crop;
mod edit;
mod encode;
mod error;
mod quantize;
mod thumb;

pub use encode::{RgbaView, encode_jpeg, encode_png_lossless, encode_png_lossy, encode_webp};
pub use edit::{
    EditParams, Encoded, OutFormat, PngMode, SrcFormat, apply, downscale, out_dims, src_format_of,
};
pub use crop::{CropRect, crop_rgba, orient, oriented_dims};
pub use quantize::quantize;
pub use error::ImagingError;
pub use thumb::{Decoded, DecodedWithIcc, Thumbnail, decode_rgba, decode_rgba_icc, make_thumbnail};
