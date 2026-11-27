//! Glance 图像解码与处理核心库（纯 Rust 接口，不依赖 Tauri）。

mod crop;
mod edit;
mod encode;
mod error;
mod exifblob;
pub mod heif;
mod quantize;
mod removebg;
mod thumb;

pub use encode::{
    RgbaView, encode_jpeg, encode_png_fast, encode_png_lossless, encode_png_lossy, encode_png_stored,
    encode_webp,
};
pub use edit::{
    EditParams, Encoded, OutFormat, PngMode, SrcFormat, apply, downscale, out_dims, src_format_of,
};
pub use crop::{CropRect, crop_rgba, orient, oriented_dims};
pub use quantize::quantize;
pub use removebg::{RemoveBg, pick, remove_bg};
pub use error::ImagingError;
pub use exifblob::normalize_exif;
pub use thumb::{
    Decoded, DecodedWithIcc, Thumbnail, decode_rgba, decode_rgba_icc, make_thumbnail,
    thumbnail_from_rgba,
};
