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
pub(crate) fn validate(img: &RgbaView) -> Result<(), ImagingError> {
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

/// EXIF 的 TIFF 部分（不含 `Exif\0\0`）写进 JPEG APP1 的长度上限：段长 2 字节含自身与 6 字节标识。
const MAX_JPEG_EXIF: usize = 65535 - 2 - 6;

/// JPEG 没有透明通道：按 fill 颜色铺底后编码。
/// icc 非空时写入 ICC 配置文件（APP2 标记）。
/// exif 是已改写好的 TIFF 结构（见 `normalize_exif`），非空且不超过 65527 字节时
/// 写成紧跟 SOI 的 APP1，在 ICC 之前；超长则不写。
pub fn encode_jpeg(
    img: RgbaView,
    quality: u8,
    fill: [u8; 3],
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
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
    let mut out = catch_unwind(AssertUnwindSafe(|| -> std::io::Result<Vec<u8>> {
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
    .map_err(encode_err)?;
    if let Some(tiff) = exif.filter(|t| !t.is_empty() && t.len() <= MAX_JPEG_EXIF) {
        // 编码器会先写 JFIF 的 APP0，EXIF 要排在最前，所以编码完再插到 SOI 之后。
        let mut seg = Vec::with_capacity(tiff.len() + 10);
        seg.extend([0xFF, 0xE1]);
        seg.extend(((tiff.len() + 8) as u16).to_be_bytes());
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(tiff);
        out.splice(2..2, seg);
    }
    Ok(out)
}

/// 有损 WebP。icc / exif 任一非空时输出扩展容器（`VP8X` + `ICCP` + 图像块 + `EXIF`），
/// 都为空时与编码器的原始输出逐字节相同。exif 是已改写好的 TIFF 结构。
pub fn encode_webp(
    img: RgbaView,
    quality: u8,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, ImagingError> {
    validate(&img)?;
    validate_quality(quality)?;
    let encoder = webp::Encoder::from_rgba(img.data, img.width, img.height);
    // encode_simple 返回 Result；encode() 在失败时会 unwrap panic（例如边长超过 16383）。
    let mem = encoder
        .encode_simple(false, f32::from(quality))
        .map_err(|e| ImagingError::Encode(format!("{e:?}")))?;
    let icc = icc.filter(|p| !p.is_empty());
    let exif = exif.filter(|t| !t.is_empty());
    if icc.is_none() && exif.is_none() {
        return Ok(mem.to_vec());
    }
    Ok(add_webp_meta(&mem, img.width, img.height, icc, exif))
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(kind);
    out.extend((data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
}

/// 把编码器输出的 WebP 重排成带 ICC / EXIF 的扩展容器。
/// 已有 `VP8X`（有损带透明）时在原容器上加块、改标志位；否则补一个 `VP8X`，
/// 透明标志取自 `VP8L` 头部的 alpha 位。容器读不懂时原样返回。
fn add_webp_meta(
    webp: &[u8],
    width: u32,
    height: u32,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
) -> Vec<u8> {
    const ICC_FLAG: u8 = 0x20;
    const ALPHA_FLAG: u8 = 0x10;
    const EXIF_FLAG: u8 = 0x08;
    let body = match webp {
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            rest @ ..,
        ] => rest,
        _ => return webp.to_vec(),
    };
    let (mut vp8x, rest) = if body.len() >= 18 && &body[..4] == b"VP8X" {
        (body[8..18].to_vec(), &body[18..])
    } else {
        let mut flags = 0u8;
        if body.len() >= 13 && &body[..4] == b"VP8L" && body[8] == 0x2F {
            let bits = u32::from_le_bytes([body[9], body[10], body[11], body[12]]);
            if bits & (1 << 28) != 0 {
                flags |= ALPHA_FLAG;
            }
        }
        let mut v = vec![flags, 0, 0, 0];
        v.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        v.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        (v, body)
    };
    if icc.is_some() {
        vp8x[0] |= ICC_FLAG;
    }
    if exif.is_some() {
        vp8x[0] |= EXIF_FLAG;
    }
    let mut out = Vec::with_capacity(
        webp.len() + 64 + icc.map_or(0, <[u8]>::len) + exif.map_or(0, <[u8]>::len),
    );
    out.extend_from_slice(b"RIFF\0\0\0\0WEBP");
    push_chunk(&mut out, b"VP8X", &vp8x);
    if let Some(icc) = icc {
        push_chunk(&mut out, b"ICCP", icc);
    }
    out.extend_from_slice(rest);
    if let Some(exif) = exif {
        push_chunk(&mut out, b"EXIF", exif);
    }
    match u32::try_from(out.len() - 8) {
        Ok(n) => out[4..8].copy_from_slice(&n.to_le_bytes()),
        Err(_) => return webp.to_vec(),
    }
    out
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

/// 快速 PNG：`image` 的编码器（`CompressionType::Fast`），不过 oxipng、不写 ICC，供拖动预览用。
pub fn encode_png_fast(img: RgbaView) -> Result<Vec<u8>, ImagingError> {
    use image::ImageEncoder;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    validate(&img)?;
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub)
        .write_image(
            img.data,
            img.width,
            img.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(encode_err)?;
    Ok(out)
}

/// 不压缩的 PNG：不滤波、zlib 不压缩档，icc 非空时写入 iCCP。显示通道用，换编码速度不换体积。
pub fn encode_png_stored(img: RgbaView, icc: Option<&[u8]>) -> Result<Vec<u8>, ImagingError> {
    use image::ImageEncoder;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    validate(&img)?;
    let mut out = Vec::with_capacity(img.data.len() + img.height as usize + 1024);
    let mut enc = PngEncoder::new_with_quality(
        &mut out,
        CompressionType::Uncompressed,
        FilterType::NoFilter,
    );
    if let Some(icc) = icc.filter(|p| !p.is_empty()) {
        enc.set_icc_profile(icc.to_vec()).map_err(encode_err)?;
    }
    enc.write_image(
        img.data,
        img.width,
        img.height,
        image::ExtendedColorType::Rgba8,
    )
    .map_err(encode_err)?;
    Ok(out)
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
        let jpg = encode_jpeg(view(32, 32, &d), 80, [255; 3], Some(&icc), None).unwrap();
        assert_eq!(icc_of(&lossless).as_deref(), Some(icc.as_slice()));
        assert_eq!(icc_of(&lossy).as_deref(), Some(icc.as_slice()));
        assert_eq!(icc_of(&jpg).as_deref(), Some(icc.as_slice()));
    }

    #[test]
    fn png_stored_roundtrip_with_icc() {
        let icc = fake_icc();
        let d = noise_gradient(1000, 1000);
        let out = encode_png_stored(view(1000, 1000, &d), Some(&icc)).unwrap();
        // 不压缩：输出不比原始像素小（1000 × 1000 × 4 = 4 000 000 字节）。
        assert!(out.len() >= 4_000_000, "{} 字节", out.len());
        assert_eq!(icc_of(&out).as_deref(), Some(icc.as_slice()));
        let back = image::load_from_memory(&out).unwrap().into_rgba8();
        assert_eq!(back.dimensions(), (1000, 1000));
        assert_eq!(back.as_raw(), &d);
        // 不带 ICC 时没有 iCCP；空 ICC 同样不写。
        let plain = encode_png_stored(view(8, 8, &d[..256]), None).unwrap();
        assert_eq!(icc_of(&plain), None);
        let empty = encode_png_stored(view(8, 8, &d[..256]), Some(&[])).unwrap();
        assert_eq!(icc_of(&empty), None);
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

    fn exif_of(bytes: &[u8]) -> exif::Exif {
        crate::exifblob::fixtures::exif_of_jpeg(bytes)
    }

    fn make_of(x: &exif::Exif) -> String {
        match &x
            .get_field(exif::Tag::Make, exif::In::PRIMARY)
            .unwrap()
            .value
        {
            exif::Value::Ascii(v) => String::from_utf8(v[0].clone()).unwrap(),
            _ => panic!("make type"),
        }
    }

    /// 顺着 RIFF 容器列出各块：(四字符码, 数据)。
    fn webp_chunks(b: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        assert_eq!(&b[..4], b"RIFF");
        assert_eq!(&b[8..12], b"WEBP");
        assert_eq!(
            u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize,
            b.len() - 8
        );
        let mut out = Vec::new();
        let mut pos = 12;
        while pos < b.len() {
            let len = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
            out.push((
                b[pos..pos + 4].try_into().unwrap(),
                b[pos + 8..pos + 8 + len].to_vec(),
            ));
            pos += 8 + len + (len & 1);
        }
        assert_eq!(pos, b.len());
        out
    }

    #[test]
    fn jpeg_exif_roundtrip() {
        let d = noise_gradient(32, 32);
        let tiff = crate::exifblob::fixtures::sample();
        let jpg = encode_jpeg(view(32, 32, &d), 80, [255; 3], None, Some(&tiff)).unwrap();
        assert_eq!(make_of(&exif_of(&jpg)), "Acme");
        // APP1 紧跟 SOI。
        assert_eq!(&jpg[2..4], &[0xFF, 0xE1]);
        assert_eq!(&jpg[6..12], b"Exif\0\0");

        let icc = fake_icc();
        let both = encode_jpeg(view(32, 32, &d), 80, [255; 3], Some(&icc), Some(&tiff)).unwrap();
        assert_eq!(make_of(&exif_of(&both)), "Acme");
        assert_eq!(icc_of(&both).as_deref(), Some(icc.as_slice()));
        // EXIF 在 ICC 之前。
        let exif_at = both.windows(6).position(|w| w == b"Exif\0\0").unwrap();
        let icc_at = both.windows(11).position(|w| w == b"ICC_PROFILE").unwrap();
        assert!(exif_at < icc_at);
    }

    #[test]
    fn jpeg_exif_too_long_is_skipped() {
        let d = noise_gradient(16, 16);
        let mut tiff = crate::exifblob::fixtures::sample();
        tiff.resize(65528, 0);
        let jpg = encode_jpeg(view(16, 16, &d), 80, [255; 3], None, Some(&tiff)).unwrap();
        assert!(!jpg.windows(6).any(|w| w == b"Exif\0\0"));
        tiff.truncate(65527);
        let jpg = encode_jpeg(view(16, 16, &d), 80, [255; 3], None, Some(&tiff)).unwrap();
        assert!(jpg.windows(6).any(|w| w == b"Exif\0\0"));
    }

    #[test]
    fn webp_without_meta_is_unchanged() {
        let d = noise_gradient(40, 24);
        let old = webp::Encoder::from_rgba(&d, 40, 24)
            .encode_simple(false, 80.0)
            .unwrap()
            .to_vec();
        assert_eq!(encode_webp(view(40, 24, &d), 80, None, None).unwrap(), old);
        assert_eq!(
            encode_webp(view(40, 24, &d), 80, Some(&[]), Some(&[])).unwrap(),
            old
        );
    }

    #[test]
    fn webp_keeps_icc_and_exif() {
        let d = noise_gradient(40, 24);
        let icc = fake_icc();
        let tiff = crate::exifblob::fixtures::sample();
        let out = encode_webp(view(40, 24, &d), 80, Some(&icc), Some(&tiff)).unwrap();
        assert_eq!(icc_of(&out).as_deref(), Some(icc.as_slice()));
        let chunks = webp_chunks(&out);
        let names: Vec<_> = chunks.iter().map(|c| &c.0).collect();
        assert_eq!(names, [b"VP8X", b"ICCP", b"VP8 ", b"EXIF"]);
        assert_eq!(chunks[0].1[0], 0x20 | 0x08);
        assert_eq!(&chunks[0].1[4..7], &[39, 0, 0]);
        assert_eq!(&chunks[0].1[7..10], &[23, 0, 0]);
        assert_eq!(chunks[3].1, tiff);
        // 解码得到同样的像素尺寸。
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (40, 24));

        // 只有 EXIF、只有 ICC 也能读回。
        let only_exif = encode_webp(view(40, 24, &d), 80, None, Some(&tiff)).unwrap();
        assert_eq!(webp_chunks(&only_exif).last().unwrap().1, tiff);
        let only_icc = encode_webp(view(40, 24, &d), 80, Some(&icc), None).unwrap();
        assert_eq!(icc_of(&only_icc).as_deref(), Some(icc.as_slice()));
    }

    #[test]
    fn webp_odd_length_exif_is_padded() {
        let d = noise_gradient(16, 16);
        let mut tiff = crate::exifblob::fixtures::sample();
        if tiff.len().is_multiple_of(2) {
            tiff.push(0);
        }
        let out = encode_webp(view(16, 16, &d), 80, None, Some(&tiff)).unwrap();
        assert_eq!(out.len() % 2, 0);
        assert_eq!(webp_chunks(&out).last().unwrap().1, tiff);
    }

    #[test]
    fn webp_with_alpha_keeps_alpha_icc_exif() {
        let (w, h) = (48u32, 32u32);
        let mut d = noise_gradient(w, h);
        for (i, px) in d.chunks_exact_mut(4).enumerate() {
            px[3] = (i % 251) as u8;
        }
        let icc = fake_icc();
        let tiff = crate::exifblob::fixtures::sample();
        let out = encode_webp(view(w, h, &d), 80, Some(&icc), Some(&tiff)).unwrap();
        let chunks = webp_chunks(&out);
        assert_eq!(chunks.iter().filter(|c| &c.0 == b"VP8X").count(), 1);
        assert_eq!(chunks[0].1[0], 0x20 | 0x10 | 0x08);
        assert_eq!(icc_of(&out).as_deref(), Some(icc.as_slice()));
        assert_eq!(chunks.last().unwrap().1, tiff);
        let img = image::load_from_memory(&out).unwrap().into_rgba8();
        for (src, got) in d.chunks_exact(4).zip(img.pixels()) {
            assert_eq!(src[3], got[3]);
        }
    }

    #[test]
    fn webp_lossless_alpha_flag_from_vp8l_header() {
        // libwebp 的有损编码不会出 VP8L；直接拼一个 VP8L 块来验证重排逻辑的透明标志。
        let mut vp8l = vec![0x2F, 7, 0, 0, 0x10]; // 宽高各 8，alpha 位在第 28 位
        vp8l.extend([0u8; 3]);
        let mut riff = b"RIFF".to_vec();
        riff.extend((4 + 8 + vp8l.len() as u32).to_le_bytes());
        riff.extend(b"WEBPVP8L");
        riff.extend((vp8l.len() as u32).to_le_bytes());
        riff.extend(&vp8l);
        let out = add_webp_meta(&riff, 8, 8, None, Some(&[1, 2, 3, 4]));
        let chunks = webp_chunks(&out);
        assert_eq!(&chunks[0].0, b"VP8X");
        assert_eq!(chunks[0].1[0] & 0x10, 0x10);
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
            encode_jpeg(v(), 80, [255; 3], None, None).unwrap(),
            encode_jpeg(v(), 80, [255; 3], None, None).unwrap()
        );
        assert_eq!(
            encode_webp(v(), 80, None, None).unwrap(),
            encode_webp(v(), 80, None, None).unwrap()
        );
    }
}
