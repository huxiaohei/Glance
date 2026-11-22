use std::panic::{AssertUnwindSafe, catch_unwind};

use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

use crate::error::ImagingError;

/// 8 位 RGBA，行优先，长度必须等于 width * height * 4。
pub struct RgbaView<'a> {
    pub width: u32,
    pub height: u32,
    pub data: &'a [u8],
}

/// 统一的输入校验：尺寸非零、长度恰好等于 width * height * 4（用 checked 运算防溢出）。
fn validate(img: &RgbaView) -> Result<(), ImagingError> {
    let expected = (img.width as usize)
        .checked_mul(img.height as usize)
        .and_then(|px| px.checked_mul(4));
    if img.width == 0 || img.height == 0 || expected != Some(img.data.len()) {
        return Err(ImagingError::InvalidBuffer {
            width: img.width,
            height: img.height,
            len: img.data.len(),
        });
    }
    Ok(())
}

fn validate_quality(quality: u8) -> Result<(), ImagingError> {
    if (1..=100).contains(&quality) {
        Ok(())
    } else {
        Err(ImagingError::InvalidQuality(quality))
    }
}

fn encode_err(e: impl std::fmt::Display) -> ImagingError {
    ImagingError::Encode(e.to_string())
}

/// JPEG 没有透明通道：按 fill 颜色铺底后编码。
pub fn encode_jpeg(img: RgbaView, quality: u8, fill: [u8; 3]) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    validate_quality(quality)?;

    // 按 alpha 把像素合成到 fill 底色上，得到 RGB。
    let mut rgb = Vec::with_capacity(img.data.len() / 4 * 3);
    for px in img.data.chunks_exact(4) {
        let a = u32::from(px[3]);
        for c in 0..3 {
            let v = (u32::from(px[c]) * a + u32::from(fill[c]) * (255 - a) + 127) / 255;
            rgb.push(v as u8);
        }
    }

    // mozjpeg 内部出错时会 panic（unwinding 错误处理），在这里转成错误。
    catch_unwind(AssertUnwindSafe(|| -> std::io::Result<Vec<u8>> {
        let mut comp = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        comp.set_size(img.width as usize, img.height as usize);
        comp.set_quality(f32::from(quality));
        let mut started = comp.start_compress(Vec::new())?;
        started.write_scanlines(&rgb)?;
        started.finish()
    }))
    .map_err(|_| ImagingError::Encode("mozjpeg 内部错误".into()))?
    .map_err(encode_err)
}

pub fn encode_webp(img: RgbaView, quality: u8) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    validate_quality(quality)?;
    let encoder = webp::Encoder::from_rgba(img.data, img.width, img.height);
    // encode_simple 返回 Result；encode() 在失败时会 unwrap panic（例如边长超过 16383）。
    let mem = encoder
        .encode_simple(false, f32::from(quality))
        .map_err(|e| ImagingError::Encode(format!("{e:?}")))?;
    Ok(mem.to_vec())
}

/// 无损：先用 image 编成 PNG，再过 oxipng（预设等级 2）。
pub fn encode_png_lossless(img: RgbaView) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(img.data, img.width, img.height, ExtendedColorType::Rgba8)
        .map_err(encode_err)?;
    oxipng::optimize_from_memory(&png, &oxipng::Options::from_preset(2)).map_err(encode_err)
}
