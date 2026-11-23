use std::io::Cursor;

use fast_image_resize::images::Image;
use fast_image_resize::{MulDiv, PixelType, ResizeOptions, Resizer};
use image::{DynamicImage, ImageDecoder, ImageReader};

use crate::encode::{RgbaView, encode_webp};
use crate::error::ImagingError;

const THUMB_QUALITY: u8 = 80;

/// 缩略图：宽高（像素）与有损 WebP 编码后的字节。
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    pub webp: Vec<u8>,
}

/// bytes 是整个图片文件的内容。长边缩到不超过 max_edge，不放大；
/// 应用 EXIF 方向；动图取第一帧；输出有损 WebP（质量 80），保留透明通道。
pub fn make_thumbnail(bytes: &[u8], max_edge: u32) -> Result<Thumbnail, ImagingError> {
    if max_edge == 0 {
        return Err(ImagingError::InvalidMaxEdge);
    }
    let img = decode_oriented(bytes, u64::MAX)?;

    let has_alpha = img.color().has_alpha();
    let src = img.into_rgba8();
    let (sw, sh) = src.dimensions();
    let (tw, th) = target_size(sw, sh, max_edge);

    let pixels = if (tw, th) == (sw, sh) {
        src.into_raw()
    } else {
        resize_rgba(src.into_raw(), (sw, sh), (tw, th), has_alpha)?
    };
    let webp = encode_webp(
        RgbaView {
            width: tw,
            height: th,
            data: &pixels,
        },
        THUMB_QUALITY,
    )?;
    Ok(Thumbnail {
        width: tw,
        height: th,
        webp,
    })
}

/// 解码后的图：宽高（像素，已按 EXIF 方向转正）与逐行排列的 RGBA8 像素。
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// 解码并按 EXIF 方向转正；宽 × 高超过 max_pixels 时返回 ImagingError::TooLarge，不解码。动图取第一帧。
pub fn decode_rgba(bytes: &[u8], max_pixels: u64) -> Result<Decoded, ImagingError> {
    let src = decode_oriented(bytes, max_pixels)?.into_rgba8();
    let (width, height) = src.dimensions();
    Ok(Decoded {
        width,
        height,
        rgba: src.into_raw(),
    })
}

/// 先从文件头取尺寸，超过 max_pixels 就不再解码；再解码（动图取第一帧）并应用 EXIF 方向。
fn decode_oriented(bytes: &[u8], max_pixels: u64) -> Result<DynamicImage, ImagingError> {
    let decode_err = |e: &dyn std::fmt::Display| ImagingError::Decode(e.to_string());

    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| decode_err(&e))?;
    let mut decoder = reader.into_decoder().map_err(|e| decode_err(&e))?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > max_pixels {
        return Err(ImagingError::TooLarge);
    }
    let orientation = decoder.orientation().map_err(|e| decode_err(&e))?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| decode_err(&e))?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// 长边缩到 max_edge（不放大），另一边四舍五入且不小于 1。
fn target_size(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= max_edge {
        return (w, h);
    }
    let scale = |v: u32| {
        ((u64::from(v) * u64::from(max_edge) + u64::from(long) / 2) / u64::from(long)).max(1) as u32
    };
    (scale(w), scale(h))
}

/// 带透明通道时先预乘 alpha、缩放后再还原，避免透明边缘发黑。
fn resize_rgba(
    pixels: Vec<u8>,
    (sw, sh): (u32, u32),
    (tw, th): (u32, u32),
    has_alpha: bool,
) -> Result<Vec<u8>, ImagingError> {
    let err = |e: &dyn std::fmt::Display| ImagingError::Decode(format!("缩放失败：{e}"));
    let mut src = Image::from_vec_u8(sw, sh, pixels, PixelType::U8x4).map_err(|e| err(&e))?;
    let mut dst = Image::new(tw, th, PixelType::U8x4);
    let mul_div = MulDiv::new();
    if has_alpha {
        mul_div
            .multiply_alpha_inplace(&mut src)
            .map_err(|e| err(&e))?;
    }
    Resizer::new()
        .resize(&src, &mut dst, &ResizeOptions::new())
        .map_err(|e| err(&e))?;
    if has_alpha {
        mul_div
            .divide_alpha_inplace(&mut dst)
            .map_err(|e| err(&e))?;
    }
    Ok(dst.into_vec())
}
