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
pub const MAX_JPEG_EXIF: usize = 65535 - 2 - 6;

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

/// 单个 IDAT 块的数据长度上限（PNG 规范允许到 2^31 - 1）。
const IDAT_MAX: usize = 1 << 30;
/// 一个 stored 块最多装 65535 字节。
const STORED_MAX: usize = 65535;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// slice-by-16 的 16 张表：`CRC_TABLES[0]` 是普通的逐字节表，第 k 张是“再过 k 个零字节”的结果。
const CRC_TABLES: [[u32; 256]; 16] = {
    let mut t = [[0u32; 256]; 16];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[0][n] = c;
        n += 1;
    }
    let mut n = 0;
    while n < 256 {
        let mut k = 1;
        while k < 16 {
            let prev = t[k - 1][n];
            t[k][n] = (prev >> 8) ^ t[0][(prev & 0xFF) as usize];
            k += 1;
        }
        n += 1;
    }
    t
};

/// CRC-32（PNG 用的多项式），可分段累加：首段传 0。每轮吃 16 字节（slice-by-16）。
fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    let mut c = !crc;
    let mut chunks = data.chunks_exact(16);
    for ch in &mut chunks {
        let ch: &[u8; 16] = ch.try_into().expect("chunks_exact(16)");
        let w = c ^ u32::from_le_bytes([ch[0], ch[1], ch[2], ch[3]]);
        let mut next = CRC_TABLES[15][(w & 0xFF) as usize]
            ^ CRC_TABLES[14][((w >> 8) & 0xFF) as usize]
            ^ CRC_TABLES[13][((w >> 16) & 0xFF) as usize]
            ^ CRC_TABLES[12][(w >> 24) as usize];
        for k in 4..16 {
            next ^= CRC_TABLES[15 - k][ch[k] as usize];
        }
        c = next;
    }
    for &b in chunks.remainder() {
        c = CRC_TABLES[0][((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

/// Adler-32，每 5552 字节才取一次模；块内每 16 字节一组，用
/// `b += 16 * a + Σ (16 - i) * x[i]`、`a += Σ x[i]` 展开，组内没有串行依赖，编译器可向量化。
struct Adler32 {
    a: u32,
    b: u32,
}

impl Adler32 {
    fn new() -> Self {
        Adler32 { a: 1, b: 0 }
    }

    fn update(&mut self, data: &[u8]) {
        const WEIGHTS: [u32; 16] = [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
        for part in data.chunks(5552) {
            // 16 条车道各自累加，循环里没有跨车道的依赖，编译器可向量化：
            // la = 各车道的字节和，lb = 各组开始前 la 的累计，lw = 带权字节和。
            let mut la = [0u32; 16];
            let mut lb = [0u32; 16];
            let mut lw = [0u32; 16];
            let mut groups = part.chunks_exact(16);
            let mut n_groups = 0u32;
            for g in &mut groups {
                let g: &[u8; 16] = g.try_into().expect("chunks_exact(16)");
                for i in 0..16 {
                    lb[i] += la[i];
                    let x = u32::from(g[i]);
                    la[i] += x;
                    lw[i] += WEIGHTS[i] * x;
                }
                n_groups += 1;
            }
            let sum_a: u32 = la.iter().sum();
            let sum_b: u32 = lb.iter().sum();
            let weighted: u32 = lw.iter().sum();
            // 每组的 b 增量是 16 * (该组开始前的 a) + 带权和，该组开始前的 a = a0 + Σ la_before。
            self.b += 16 * (n_groups * self.a + sum_b) + weighted;
            self.a += sum_a;
            for &x in groups.remainder() {
                self.a += u32::from(x);
                self.b += self.a;
            }
            self.a %= 65521;
            self.b %= 65521;
        }
    }

    fn finish(&self) -> u32 {
        (self.b << 16) | self.a
    }
}

/// n 字节原始数据装进 stored 块的 zlib 流长度：2 字节头 + 各块（5 字节头 + 数据）+ 4 字节 Adler。
/// 任何一步溢出返回 None。
fn zlib_stored_len(n: usize) -> Option<usize> {
    n.checked_add(5 * n.div_ceil(STORED_MAX).max(1))?
        .checked_add(6)
}

/// 不压缩 PNG 的精确字节数；任何一步溢出（只会出现在 32 位目标上的超大图）返回 None。
fn png_stored_len(width: u32, height: u32, icc_len: usize, idat_max: usize) -> Option<usize> {
    let raw = (width as usize)
        .checked_mul(4)?
        .checked_add(1)?
        .checked_mul(height as usize)?;
    let z = zlib_stored_len(raw)?;
    let idat = z.checked_add(z.div_ceil(idat_max).checked_mul(12)?)?;
    let iccp = if icc_len == 0 {
        0
    } else {
        zlib_stored_len(icc_len)?.checked_add(12 + 5)?
    };
    PNG_SIGNATURE
        .len()
        .checked_add(12 + 13)?
        .checked_add(iccp)?
        .checked_add(idat)?
        .checked_add(12)
}

fn put_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend((data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32_update(0, &out[start..]);
    out.extend(crc.to_be_bytes());
}

/// 把一段 zlib stored 流直接写进输出：每块 5 字节头 + 数据；`feed` 给出原始字节（同时算 Adler）。
fn put_zlib_stored(out: &mut Vec<u8>, raw_len: usize, mut feed: impl FnMut(&mut Vec<u8>, usize)) {
    out.extend([0x78, 0x01]);
    let mut left = raw_len;
    loop {
        let n = left.min(STORED_MAX);
        left -= n;
        out.push(u8::from(left == 0));
        out.extend((n as u16).to_le_bytes());
        out.extend((!(n as u16)).to_le_bytes());
        feed(out, n);
        if left == 0 {
            break;
        }
    }
}

/// 直接写进一次分配好的缓冲：签名、IHDR、可选 iCCP、若干 IDAT（stored 块，每行前置滤波字节 0）、IEND。
fn write_png_stored(
    img: &RgbaView,
    icc: Option<&[u8]>,
    idat_max: usize,
) -> Result<Vec<u8>, ImagingError> {
    validate(img)?;
    let icc = icc.filter(|p| !p.is_empty());
    // validate 保证 w * h * 4 不溢出；每行多 1 个滤波字节与各块头的开销都在 png_stored_len 里按
    // checked 运算累计，溢出（只会在 32 位目标上）就报错，不会写出算错长度的缓冲。
    let total = png_stored_len(img.width, img.height, icc.map_or(0, <[u8]>::len), idat_max)
        .ok_or_else(|| encode_err("图像过大"))?;
    let w4 = img.width as usize * 4;
    let raw = img.height as usize * (1 + w4);
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&PNG_SIGNATURE);

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&img.width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&img.height.to_be_bytes());
    ihdr[8] = 8; // 位深
    ihdr[9] = 6; // RGBA
    put_chunk(&mut out, b"IHDR", &ihdr);

    if let Some(icc) = icc {
        // 小缓冲：名字 "ICC" + 0 + 压缩方法 0 + stored 的 zlib 流。
        let mut body = Vec::with_capacity(5 + zlib_stored_len(icc.len()).unwrap_or(0));
        body.extend_from_slice(b"ICC\0\0");
        let mut ad = Adler32::new();
        let mut pos = 0;
        put_zlib_stored(&mut body, icc.len(), |o, n| {
            o.extend_from_slice(&icc[pos..pos + n]);
            ad.update(&icc[pos..pos + n]);
            pos += n;
        });
        body.extend(ad.finish().to_be_bytes());
        put_chunk(&mut out, b"iCCP", &body);
    }

    // IDAT：zlib 流按 idat_max 切成若干块；先占长度与类型，写满再回填长度并补 CRC。
    let z_len = zlib_stored_len(raw).unwrap_or(0);
    let mut chunk_start = out.len();
    let mut chunk_left = idat_max.min(z_len);
    out.extend([0u8; 4]);
    out.extend_from_slice(b"IDAT");
    let mut emitted = 0usize;
    // 把 bytes 追加进当前 IDAT，满了就封口开下一块。
    let mut push = |out: &mut Vec<u8>, mut bytes: &[u8]| {
        while !bytes.is_empty() {
            if chunk_left == 0 {
                let len = out.len() - chunk_start - 8;
                out[chunk_start..chunk_start + 4].copy_from_slice(&(len as u32).to_be_bytes());
                let crc = crc32_update(0, &out[chunk_start + 4..]);
                out.extend(crc.to_be_bytes());
                chunk_start = out.len();
                chunk_left = idat_max.min(z_len - emitted);
                out.extend([0u8; 4]);
                out.extend_from_slice(b"IDAT");
            }
            let n = chunk_left.min(bytes.len());
            out.extend_from_slice(&bytes[..n]);
            bytes = &bytes[n..];
            chunk_left -= n;
            emitted += n;
        }
    };

    push(&mut out, &[0x78, 0x01]);
    let mut ad = Adler32::new();
    let mut pos = 0usize; // 在“带滤波字节的原始流”里的位置
    let mut left = raw;
    loop {
        let n = left.min(STORED_MAX);
        left -= n;
        let n16 = n as u16;
        let mut hdr = [0u8; 5];
        hdr[0] = u8::from(left == 0);
        hdr[1..3].copy_from_slice(&n16.to_le_bytes());
        hdr[3..5].copy_from_slice(&(!n16).to_le_bytes());
        push(&mut out, &hdr);
        let mut need = n;
        while need > 0 {
            let (row, off) = (pos / (1 + w4), pos % (1 + w4));
            if off == 0 {
                push(&mut out, &[0]);
                ad.update(&[0]);
                pos += 1;
                need -= 1;
                continue;
            }
            let take = need.min(1 + w4 - off);
            let src = &img.data[row * w4 + off - 1..][..take];
            push(&mut out, src);
            ad.update(src);
            pos += take;
            need -= take;
        }
        if left == 0 {
            break;
        }
    }
    push(&mut out, &ad.finish().to_be_bytes());
    // 封最后一个 IDAT。
    let len = out.len() - chunk_start - 8;
    out[chunk_start..chunk_start + 4].copy_from_slice(&(len as u32).to_be_bytes());
    let crc = crc32_update(0, &out[chunk_start + 4..]);
    out.extend(crc.to_be_bytes());

    put_chunk(&mut out, b"IEND", &[]);
    debug_assert_eq!(out.len(), total);
    Ok(out)
}

/// 不压缩的 PNG：不滤波、zlib 只用 stored 块，icc 非空时写入 iCCP。显示通道用，换编码速度不换体积。
/// 直接写进一次按精确长度分配的缓冲，没有中间的整幅副本。
pub fn encode_png_stored(img: RgbaView, icc: Option<&[u8]>) -> Result<Vec<u8>, ImagingError> {
    write_png_stored(&img, icc, IDAT_MAX)
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

    fn assert_stored_roundtrip(w: u32, h: u32, d: &[u8], icc: Option<&[u8]>, idat_max: usize) {
        let out = write_png_stored(&view(w, h, d), icc, idat_max).unwrap();
        let expect = png_stored_len(w, h, icc.map_or(0, <[u8]>::len), idat_max).unwrap();
        assert_eq!(out.len(), expect, "{w}x{h} 实际长度与预算不符");
        assert_eq!(out.capacity(), out.len(), "{w}x{h} 缓冲发生过扩容");
        let back = image::load_from_memory(&out).unwrap().into_rgba8();
        assert_eq!(back.dimensions(), (w, h));
        assert_eq!(back.as_raw(), d);
        assert_eq!(icc_of(&out).as_deref(), icc.filter(|p| !p.is_empty()));
    }

    #[test]
    fn png_stored_exact_size_and_roundtrip_variants() {
        let icc = fake_icc();
        // 不透明（噪点渐变）。
        let d = noise_gradient(37, 23);
        assert_stored_roundtrip(37, 23, &d, None, usize::MAX >> 1);
        assert_stored_roundtrip(37, 23, &d, Some(&icc), usize::MAX >> 1);
        // 半透明。
        let semi: Vec<u8> = (0..37 * 23)
            .flat_map(|i| [i as u8, (i * 3) as u8, (i * 7) as u8, (i % 251) as u8])
            .collect();
        assert_stored_roundtrip(37, 23, &semi, Some(&icc), usize::MAX >> 1);
        // 1x1。
        assert_stored_roundtrip(1, 1, &[1, 2, 3, 4], None, usize::MAX >> 1);
        assert_stored_roundtrip(1, 1, &[1, 2, 3, 4], Some(&icc), usize::MAX >> 1);
    }

    #[test]
    fn png_stored_crosses_stored_block_boundary() {
        // 每行 1 + 4w 字节：w = 16383 时一行 65533 字节，第二行的数据跨过 65535 的块边界；
        // 另取行长恰为 65535 的情形（w = 16383.5 不存在，用 w = 16384 的 65537 字节行）。
        for (w, h) in [(16383u32, 3u32), (16384, 3), (4096, 40), (100, 700)] {
            let d = noise_gradient(w, h);
            assert_stored_roundtrip(w, h, &d, None, usize::MAX >> 1);
        }
    }

    #[test]
    fn png_stored_splits_idat_chunks() {
        // IDAT 上限压到很小，强制切成很多块，仍要能读回。
        let icc = fake_icc();
        let d = noise_gradient(300, 50);
        assert_stored_roundtrip(300, 50, &d, Some(&icc), 1000);
        assert_stored_roundtrip(300, 50, &d, None, 70_000);
    }

    #[test]
    fn png_stored_public_fn_is_exact_size() {
        let d = noise_gradient(200, 100);
        let out = encode_png_stored(view(200, 100, &d), None).unwrap();
        assert_eq!(out.len(), png_stored_len(200, 100, 0, IDAT_MAX).unwrap());
        assert_eq!(out.capacity(), out.len());
    }

    #[test]
    fn png_stored_len_reports_overflow() {
        assert_eq!(png_stored_len(u32::MAX, u32::MAX, 0, IDAT_MAX), None);
        assert_eq!(png_stored_len(1, 1, usize::MAX, IDAT_MAX), None);
        assert!(png_stored_len(4000, 3000, 0, IDAT_MAX).is_some());
    }

    #[test]
    fn png_stored_rejects_bad_buffer() {
        assert!(encode_png_stored(view(2, 2, &[0; 15]), None).is_err());
        assert!(encode_png_stored(view(0, 2, &[]), None).is_err());
    }

    /// 计时：4000x3000 不压缩 PNG 编码，取 5 次中位数。
    /// `cargo test --release -p glance-imaging png_stored_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn png_stored_timing_4000x3000() {
        let (w, h) = (4000u32, 3000u32);
        let mut seed = 99u32;
        let d: Vec<u8> = (0..w as usize * h as usize * 4)
            .map(|i| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8 ^ (i >> 8) as u8
            })
            .collect();
        let mut times: Vec<f64> = (0..5)
            .map(|_| {
                let t = std::time::Instant::now();
                let out = encode_png_stored(view(w, h, &d), None).unwrap();
                std::hint::black_box(&out);
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!(
            "encode_png_stored 4000x3000 中位数 {:.1} ms（5 次：{times:.1?}）",
            times[2]
        );
    }

    /// 逐字节的参考实现（慢但一眼能看懂）。
    fn crc32_ref(crc: u32, data: &[u8]) -> u32 {
        let mut c = !crc;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    fn adler32_ref(data: &[u8]) -> u32 {
        let (mut a, mut b) = (1u64, 0u64);
        for &x in data {
            a = (a + u64::from(x)) % 65521;
            b = (b + a) % 65521;
        }
        ((b << 16) | a) as u32
    }

    fn pseudo(len: usize, seed: u32) -> Vec<u8> {
        let mut s = seed;
        (0..len)
            .map(|_| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                (s >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn checksums_match_bytewise_reference() {
        let mut lens = vec![
            0usize, 1, 7, 8, 9, 15, 16, 17, 5551, 5552, 5553, 11104, 70000,
        ];
        lens.push(65535 * 2 + 3);
        for &len in &lens {
            // 0xFF 全满的数据最容易让 Adler 的累加溢出；再配一份随机数据。
            for data in [pseudo(len + 3, len as u32 + 1), vec![255u8; len + 3]] {
                // 起点偏移 0..3 以改变对齐。
                for off in 0..3 {
                    let d = &data[off..off + len];
                    assert_eq!(
                        crc32_update(0, d),
                        crc32_ref(0, d),
                        "crc len {len} off {off}"
                    );
                    assert_eq!(crc32_update(0x1234_5678, d), crc32_ref(0x1234_5678, d));
                    let mut a = Adler32::new();
                    a.update(d);
                    assert_eq!(a.finish(), adler32_ref(d), "adler len {len} off {off}");
                }
            }
        }
    }

    #[test]
    fn checksums_split_updates_equal_one_call() {
        let data = pseudo(70000, 7);
        for cuts in [
            &[1usize, 8, 9, 5551, 5552, 5553, 30000][..],
            &[3, 4, 5, 6],
            &[69999],
        ] {
            let (mut crc, mut ad) = (0u32, Adler32::new());
            let mut at = 0;
            for &c in cuts.iter().chain(std::iter::once(&data.len())) {
                crc = crc32_update(crc, &data[at..c]);
                ad.update(&data[at..c]);
                at = c;
            }
            assert_eq!(crc, crc32_ref(0, &data));
            assert_eq!(ad.finish(), adler32_ref(&data));
        }
    }

    #[test]
    fn crc32_and_adler32_known_values() {
        assert_eq!(crc32_update(0, b"123456789"), 0xCBF4_3926);
        let mut a = Adler32::new();
        a.update(b"Wikipedia");
        assert_eq!(a.finish(), 0x11E6_0398);
        // 超过 5552 字节的延迟取模路径。
        let big = vec![255u8; 100_000];
        let mut a = Adler32::new();
        a.update(&big);
        let (mut s1, mut s2) = (1u64, 0u64);
        for &x in &big {
            s1 = (s1 + u64::from(x)) % 65521;
            s2 = (s2 + s1) % 65521;
        }
        assert_eq!(a.finish(), ((s2 << 16) | s1) as u32);
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
        // 签名 0x2F 后的 32 位小端：宽 - 1（14 位）、高 - 1（14 位）、alpha 位（第 28 位）。
        // 0x1001_C007 = 宽高各 8，alpha 位置 1。
        let mut vp8l = vec![0x2F, 0x07, 0xC0, 0x01, 0x10];
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
