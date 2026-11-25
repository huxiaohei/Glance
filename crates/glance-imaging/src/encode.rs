use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::error::ImagingError;
use crate::quantize::quantize;

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
/// icc 非空时写入 ICC 配置文件（APP2 标记）。
pub fn encode_jpeg(
    img: RgbaView,
    quality: u8,
    fill: [u8; 3],
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, ImagingError> {
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
        if let Some(icc) = icc.filter(|p| !p.is_empty()) {
            // 自己写 APP2：mozjpeg::write_icc_profile 的分块序号从 0 起，
            // 而 ICC 规范（及 zune-jpeg 等解码器）要求从 1 起，读不回来。
            const MAX_DATA_PER_MARKER: usize = 65533 - 14;
            let chunks = icc.chunks(MAX_DATA_PER_MARKER);
            let total = chunks.len() as u8;
            for (i, chunk) in chunks.enumerate() {
                let mut buf = Vec::with_capacity(chunk.len() + 14);
                buf.extend_from_slice(b"ICC_PROFILE\0");
                buf.extend([i as u8 + 1, total]);
                buf.extend_from_slice(chunk);
                started.write_marker(mozjpeg::Marker::APP(2), &buf);
            }
        }
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

/// 无损：走 oxipng 的 RawImage（预设等级 2）；icc 非空时写入 iCCP。
pub fn encode_png_lossless(img: RgbaView, icc: Option<&[u8]>) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    let mut raw = oxipng::RawImage::new(
        img.width,
        img.height,
        oxipng::ColorType::RGBA,
        oxipng::BitDepth::Eight,
        img.data.to_vec(),
    )
    .map_err(encode_err)?;
    add_icc(&mut raw, icc);
    raw.create_optimized_png(&oxipng::Options::from_preset(2))
        .map_err(encode_err)
}

/// 有损：先减色成索引图（保留透明通道），再走 oxipng 输出索引 PNG。
/// 质量 1..=100 映射到颜色数 18..=256 与采样因子 30..=10。
pub fn encode_png_lossy(
    img: RgbaView,
    quality: u8,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    validate_quality(quality)?;
    let colors = 16 + (u16::from(quality) * 240) / 100;
    let sample = (30 - i32::from(quality) / 5).clamp(1, 30);
    let (palette, indices) = quantize(
        RgbaView {
            width: img.width,
            height: img.height,
            data: img.data,
        },
        colors,
        sample,
    );
    let palette = palette
        .into_iter()
        .map(|[r, g, b, a]| oxipng::RGBA8::new(r, g, b, a))
        .collect();
    let mut raw = oxipng::RawImage::new(
        img.width,
        img.height,
        oxipng::ColorType::Indexed { palette },
        oxipng::BitDepth::Eight,
        indices,
    )
    .map_err(encode_err)?;
    add_icc(&mut raw, icc);
    raw.create_optimized_png(&oxipng::Options::from_preset(2))
        .map_err(encode_err)
}

fn add_icc(raw: &mut oxipng::RawImage, icc: Option<&[u8]>) {
    if let Some(icc) = icc.filter(|p| !p.is_empty()) {
        raw.add_icc_profile(icc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageDecoder, ImageReader};
    use std::io::Cursor;

    fn noise_gradient(w: u32, h: u32) -> Vec<u8> {
        let mut seed = 12345u32;
        let mut d = Vec::new();
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let n = (seed >> 24) as u8 / 8;
                d.extend_from_slice(&[
                    (x as u8).wrapping_add(n),
                    (y as u8).wrapping_add(n),
                    ((x + y) / 2) as u8,
                    255,
                ]);
            }
        }
        d
    }

    fn view(w: u32, h: u32, d: &[u8]) -> RgbaView<'_> {
        RgbaView {
            width: w,
            height: h,
            data: d,
        }
    }

    #[test]
    fn lossy_png_keeps_alpha() {
        let (w, h) = (64u32, 16u32);
        let mut d = Vec::new();
        for _ in 0..h {
            for x in 0..w {
                let a = if x < 31 {
                    0
                } else if x == 31 {
                    128
                } else {
                    255
                };
                d.extend_from_slice(&[(x * 3) as u8, 40, 200, a]);
            }
        }
        let png = encode_png_lossy(view(w, h, &d), 60, None).unwrap();
        let img = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(img.get_pixel(5, 3)[3], 0);
        assert!(
            (112..=144).contains(&img.get_pixel(31, 3)[3]),
            "alpha={}",
            img.get_pixel(31, 3)[3]
        );
        assert_eq!(img.get_pixel(50, 3)[3], 255);
    }

    #[test]
    fn lossy_png_many_colors_keeps_fully_transparent() {
        let (w, h) = (128u32, 128u32);
        let mut d = noise_gradient(w, h);
        for px in d.chunks_exact_mut(4).take((w * h / 2) as usize) {
            px[3] = 0;
        }
        let png = encode_png_lossy(view(w, h, &d), 50, None).unwrap();
        let img = image::load_from_memory(&png).unwrap().into_rgba8();
        assert!(img.pixels().take((w * h / 2) as usize).all(|p| p[3] == 0));
        assert!(img.pixels().skip((w * h / 2) as usize).all(|p| p[3] == 255));
    }

    #[test]
    fn lossy_png_many_colors_semi_transparent_alpha_error_small() {
        let (w, h) = (128u32, 64u32);
        let mut d = noise_gradient(w, h);
        for y in 0..h {
            for x in 0..w {
                let a = match x {
                    0..=19 => 0,
                    20..=39 => 64,
                    40..=59 => 128,
                    60..=99 => (255 * (x - 60) / 39) as u8, // 柔和渐变
                    _ => 255,
                };
                d[((y * w + x) * 4 + 3) as usize] = a;
            }
        }
        for q in [20u8, 60, 100] {
            let png = encode_png_lossy(view(w, h, &d), q, None).unwrap();
            let img = image::load_from_memory(&png).unwrap().into_rgba8();
            for (src, out) in d.chunks_exact(4).zip(img.pixels()) {
                match src[3] {
                    0 => assert_eq!(out[3], 0),
                    255 => assert_eq!(out[3], 255),
                    a => assert!(a.abs_diff(out[3]) <= 24, "q={q} alpha {a} -> {}", out[3]),
                }
            }
        }
    }

    #[test]
    fn lossy_png_smaller_than_lossless() {
        let d = noise_gradient(256, 256);
        let lossy = encode_png_lossy(view(256, 256, &d), 60, None).unwrap();
        let lossless = encode_png_lossless(view(256, 256, &d), None).unwrap();
        assert!(lossy.len() < lossless.len());
    }

    #[test]
    fn lossy_quality_monotonic() {
        let d = noise_gradient(256, 256);
        let lo = encode_png_lossy(view(256, 256, &d), 20, None).unwrap();
        let hi = encode_png_lossy(view(256, 256, &d), 90, None).unwrap();
        assert!(lo.len() <= hi.len());
    }

    fn fake_icc() -> Vec<u8> {
        let mut p = vec![7u8; 192];
        p[0..4].copy_from_slice(&192u32.to_be_bytes());
        p[36..40].copy_from_slice(b"acsp");
        p
    }

    fn icc_of(bytes: &[u8]) -> Option<Vec<u8>> {
        let mut dec = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        dec.icc_profile().unwrap()
    }

    #[test]
    fn png_and_jpeg_keep_icc() {
        let d = noise_gradient(32, 32);
        let icc = fake_icc();
        let lossless = encode_png_lossless(view(32, 32, &d), Some(&icc)).unwrap();
        let lossy = encode_png_lossy(view(32, 32, &d), 60, Some(&icc)).unwrap();
        let jpg = encode_jpeg(view(32, 32, &d), 80, [255; 3], Some(&icc)).unwrap();
        assert_eq!(icc_of(&lossless).as_deref(), Some(icc.as_slice()));
        assert_eq!(icc_of(&lossy).as_deref(), Some(icc.as_slice()));
        assert_eq!(icc_of(&jpg).as_deref(), Some(icc.as_slice()));
    }

    #[test]
    fn decode_rgba_icc_reads_profile() {
        let d = noise_gradient(16, 16);
        let icc = fake_icc();
        let png = encode_png_lossless(view(16, 16, &d), Some(&icc)).unwrap();
        let got = crate::decode_rgba_icc(&png, u64::MAX).unwrap();
        assert_eq!(got.icc.as_deref(), Some(icc.as_slice()));
        assert_eq!(got.decoded.rgba, d);
        let plain = encode_png_lossless(view(16, 16, &d), None).unwrap();
        assert!(
            crate::decode_rgba_icc(&plain, u64::MAX)
                .unwrap()
                .icc
                .is_none()
        );
    }

    #[test]
    fn deterministic() {
        let d = noise_gradient(64, 64);
        let v = || view(64, 64, &d);
        assert_eq!(
            encode_png_lossy(v(), 60, None).unwrap(),
            encode_png_lossy(v(), 60, None).unwrap()
        );
        assert_eq!(
            encode_png_lossless(v(), None).unwrap(),
            encode_png_lossless(v(), None).unwrap()
        );
        assert_eq!(
            encode_jpeg(v(), 80, [255; 3], None).unwrap(),
            encode_jpeg(v(), 80, [255; 3], None).unwrap()
        );
        assert_eq!(encode_webp(v(), 80).unwrap(), encode_webp(v(), 80).unwrap());
    }
}
