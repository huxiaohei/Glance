//! 单张图片的显示尺寸与详情。只读文件头（容器里图像数据之前的部分与 EXIF），不解码像素。
//!
//! EXIF 方向的适用范围与缩略图管线（glance-imaging 经 `image` 解码器）一致：
//! JPEG 的 APP1、PNG 的 eXIf 块（须在 IDAT 之前）、WebP 的 EXIF 块；GIF、BMP 没有方向。

use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use exif::{Exif, In, Tag, Value};
use serde::Serialize;

use super::registry::{FileId, Registry};
use super::scan::stamp_of;

/// 单张图片的详情，供信息面板显示。
///
/// `path` 是完整路径，只用于显示：这是“前端只见 FileId”的明确例外（另一处是
/// `RootInfo.path`），前端不得拿它访问文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetails {
    pub path: String,
    pub mtime_ms: i64,
    /// "RGB" "RGBA" "Gray" "GrayA" "Indexed"，读不出为 None。
    pub color: Option<String>,
    pub bit_depth: Option<u8>,
    pub has_alpha: Option<bool>,
    /// PNG pHYs、JPEG JFIF 密度、BMP 像素密度或 EXIF 分辨率；没有则 None。
    pub dpi: Option<(f64, f64)>,
    /// GIF 多帧、APNG、动态 WebP。
    pub animated: bool,
    /// 按 [`EXIF_KEYS`] 的顺序，只含存在的项。
    pub exif: Vec<ExifItem>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ExifItem {
    pub key: String,
    pub value: String,
}

/// EXIF 项的键与固定顺序。
pub const EXIF_KEYS: [&str; 8] = [
    "make",
    "model",
    "lens",
    "dateTime",
    "exposure",
    "fNumber",
    "iso",
    "focalLength",
];

/// 容器里嵌入的 EXIF 块的上限；超过视为损坏，不读。
const MAX_EXIF: u64 = 1 << 20;

type Src = BufReader<File>;

/// 显示尺寸：文件头里的宽高，带 EXIF 方向 5–8（转 90°）时交换宽高。读不出返回 None。
/// 只读文件头，不解码。
pub fn display_size(path: &Path) -> Option<(u32, u32)> {
    let mut r = BufReader::new(File::open(path).ok()?);
    let size = imagesize::reader_size(&mut r).ok()?;
    let (w, h) = (size.width as u32, size.height as u32);
    // 回到开头；seek_relative 在缓冲区内移动时不丢弃已读的数据
    let pos = r.stream_position().ok()?;
    r.seek_relative(-(pos as i64)).ok()?;
    let turned = probe(&mut r)
        .exif
        .as_deref()
        .and_then(parse_exif)
        .and_then(|exif| uint(&exif, Tag::Orientation))
        .is_some_and(|o| (5..=8).contains(&o));
    Some(if turned { (h, w) } else { (w, h) })
}

/// 文件不存在（或读不出元数据）返回 None；格式认不出时各项为 None。
pub fn image_details(path: &Path) -> Option<ImageDetails> {
    let stamp = stamp_of(path)?;
    let mut head = Head::default();
    if let Ok(file) = File::open(path) {
        let mut r = BufReader::new(file);
        head = probe(&mut r);
        if head.gif {
            let _ = gif_frames(&mut r, &mut head);
        }
    }
    let exif = head.exif.as_deref().and_then(parse_exif);
    let dpi = head.dpi.or_else(|| exif.as_ref().and_then(exif_dpi));
    Some(ImageDetails {
        path: path.to_string_lossy().into_owned(),
        mtime_ms: stamp.mtime_ms,
        color: head.color.map(str::to_owned),
        bit_depth: head.bit_depth,
        has_alpha: head.has_alpha,
        dpi,
        animated: head.animated,
        exif: exif.as_ref().map(exif_items).unwrap_or_default(),
    })
}

/// 由 ID 经登记表换算路径后取详情；ID 未登记或文件不在了返回 Err。
pub fn details_by_id(registry: &Registry, id: FileId) -> Result<ImageDetails, String> {
    let path = registry
        .path(id)
        .ok_or_else(|| format!("unknown file id: {}", id.0))?;
    image_details(&path).ok_or_else(|| format!("file not readable: {}", id.0))
}

/// 从文件头读到的信息。
#[derive(Default)]
struct Head {
    exif: Option<Vec<u8>>,
    color: Option<&'static str>,
    bit_depth: Option<u8>,
    has_alpha: Option<bool>,
    dpi: Option<(f64, f64)>,
    animated: bool,
    /// GIF：已读到全局颜色表之后，帧要另走 [`gif_frames`]。
    gif: bool,
}

/// 按文件签名分派。只读到图像数据之前（JPEG 的 SOS、PNG 的 IDAT），WebP 跳着走完各块。
fn probe(r: &mut Src) -> Head {
    let mut head = Head::default();
    let Some(sig) = read_arr::<4>(r) else {
        return head;
    };
    match sig {
        [0xFF, 0xD8, ..] => {
            let _ = jpeg_head(r, &mut head);
        }
        [0x89, b'P', b'N', b'G'] => {
            let _ = png_head(r, &mut head);
        }
        [b'R', b'I', b'F', b'F'] => {
            let _ = webp_head(r, &mut head);
        }
        [b'G', b'I', b'F', b'8'] => {
            let _ = gif_head(r, &mut head);
        }
        [b'B', b'M', ..] => {
            let _ = bmp_head(r, &mut head);
        }
        _ => {}
    }
    head
}

fn read_arr<const N: usize>(r: &mut Src) -> Option<[u8; N]> {
    let mut buf = [0u8; N];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read_vec(r: &mut Src, len: u64) -> Option<Vec<u8>> {
    if len > MAX_EXIF {
        return None;
    }
    let mut buf = Vec::new();
    r.take(len).read_to_end(&mut buf).ok()?;
    (buf.len() as u64 == len).then_some(buf)
}

fn skip(r: &mut Src, len: u64) -> Option<()> {
    r.seek_relative(i64::try_from(len).ok()?).ok()
}

fn u16_be(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

fn u32_be(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn u32_le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// 每米像素数 → 每英寸。
fn ppm_to_dpi(x: u32, y: u32) -> Option<(f64, f64)> {
    (x > 0 && y > 0).then(|| (f64::from(x) * 0.0254, f64::from(y) * 0.0254))
}

/// JPEG：逐段走到 SOS。取第一个 EXIF APP1、JFIF 密度与 SOF 里的位深和分量数。
/// 调用时已读过 4 个字节（SOI 和下一个标记）。
fn jpeg_head(r: &mut Src, head: &mut Head) -> Option<()> {
    r.seek_relative(-2).ok()?;
    head.has_alpha = Some(false);
    loop {
        let [ff, mut code] = read_arr::<2>(r)?;
        if ff != 0xFF {
            return None;
        }
        while code == 0xFF {
            code = read_arr::<1>(r)?[0];
        }
        match code {
            0x01 | 0xD0..=0xD7 => continue,
            0xD9 | 0xDA => return Some(()),
            _ => {}
        }
        let len = u64::from(u16_be(&read_arr::<2>(r)?)).checked_sub(2)?;
        match code {
            0xE1 if head.exif.is_none() && len >= 6 => {
                if read_arr::<6>(r)? == *b"Exif\0\0" {
                    head.exif = Some(read_vec(r, len - 6)?);
                } else {
                    skip(r, len - 6)?;
                }
            }
            0xE0 if len >= 12 => {
                let app0 = read_arr::<12>(r)?;
                if app0[..5] == *b"JFIF\0" {
                    let (x, y) = (
                        f64::from(u16_be(&app0[8..])),
                        f64::from(u16_be(&app0[10..])),
                    );
                    let scale = match app0[7] {
                        1 => Some(1.0),
                        2 => Some(2.54),
                        _ => None,
                    };
                    head.dpi = scale.filter(|_| x > 0.0 && y > 0.0).map(|s| (x * s, y * s));
                }
                skip(r, len - 12)?;
            }
            // SOF：除去 DHT（C4）、JPG（C8）、DAC（CC）
            0xC0..=0xCF if !matches!(code, 0xC4 | 0xC8 | 0xCC) && len >= 6 => {
                let sof = read_arr::<6>(r)?;
                head.bit_depth = Some(sof[0]);
                head.color = match sof[5] {
                    1 => Some("Gray"),
                    3 => Some("RGB"),
                    _ => None,
                };
                skip(r, len - 6)?;
            }
            _ => skip(r, len)?,
        }
    }
}

/// PNG：逐块走到 IDAT。IHDR 给颜色类型和位深，tRNS 表示有透明，acTL 表示 APNG。
/// 调用时已读过签名的前 4 个字节。
fn png_head(r: &mut Src, head: &mut Head) -> Option<()> {
    skip(r, 4)?;
    loop {
        let hdr = read_arr::<8>(r)?;
        let len = u64::from(u32_be(&hdr));
        match &hdr[4..] {
            b"IDAT" | b"IEND" => return Some(()),
            b"IHDR" if len >= 13 => {
                let ihdr = read_arr::<13>(r)?;
                head.bit_depth = Some(ihdr[8]);
                (head.color, head.has_alpha) = match ihdr[9] {
                    0 => (Some("Gray"), Some(false)),
                    2 => (Some("RGB"), Some(false)),
                    3 => (Some("Indexed"), Some(false)),
                    4 => (Some("GrayA"), Some(true)),
                    6 => (Some("RGBA"), Some(true)),
                    _ => (None, None),
                };
                skip(r, len - 13 + 4)?;
            }
            b"pHYs" if len >= 9 => {
                let phys = read_arr::<9>(r)?;
                if phys[8] == 1 {
                    head.dpi = ppm_to_dpi(u32_be(&phys), u32_be(&phys[4..]));
                }
                skip(r, len - 9 + 4)?;
            }
            b"tRNS" => {
                head.has_alpha = Some(true);
                skip(r, len + 4)?;
            }
            b"acTL" => {
                head.animated = true;
                skip(r, len + 4)?;
            }
            b"eXIf" if head.exif.is_none() => {
                head.exif = Some(read_vec(r, len)?);
                skip(r, 4)?;
            }
            _ => skip(r, len + 4)?,
        }
    }
}

/// WebP：RIFF 里逐块跳过。VP8X 给透明与动画标志，VP8L 头里有透明位。
fn webp_head(r: &mut Src, head: &mut Head) -> Option<()> {
    let riff = read_arr::<8>(r)?;
    if riff[4..] != *b"WEBP" {
        return None;
    }
    head.bit_depth = Some(8);
    let mut alpha = false;
    let result = (|| loop {
        let hdr = read_arr::<8>(r)?;
        let len = u64::from(u32_le(&hdr[4..]));
        let padded = len + (len & 1);
        match &hdr[..4] {
            b"VP8X" if len >= 10 => {
                let flags = read_arr::<1>(r)?[0];
                alpha |= flags & 0x10 != 0;
                head.animated = flags & 0x02 != 0;
                skip(r, padded - 1)?;
            }
            b"VP8L" if len >= 5 => {
                let l = read_arr::<5>(r)?;
                alpha |= l[0] == 0x2F && u32_le(&l[1..]) & (1 << 28) != 0;
                skip(r, padded - 5)?;
            }
            b"ALPH" => {
                alpha = true;
                skip(r, padded)?;
            }
            b"EXIF" if head.exif.is_none() => {
                let mut blob = read_vec(r, len)?;
                // 有的写入方误带了 JPEG 的 "Exif\0\0" 前缀
                if blob.starts_with(b"Exif\0\0") {
                    blob.drain(..6);
                }
                head.exif = Some(blob);
                skip(r, padded - len)?;
            }
            _ => skip(r, padded)?,
        }
    })();
    head.color = Some(if alpha { "RGBA" } else { "RGB" });
    head.has_alpha = Some(alpha);
    result
}

/// GIF：逻辑屏幕描述与全局颜色表。之后由 [`gif_frames`] 数帧。
fn gif_head(r: &mut Src, head: &mut Head) -> Option<()> {
    if read_arr::<2>(r)?[1] != b'a' {
        return None;
    }
    let lsd = read_arr::<7>(r)?;
    head.color = Some("Indexed");
    head.has_alpha = Some(false);
    let packed = lsd[4];
    if packed & 0x80 != 0 {
        let bits = (packed & 0x07) + 1;
        head.bit_depth = Some(bits);
        skip(r, 3 << bits)?;
    }
    head.gif = true;
    Some(())
}

/// 走 GIF 的块直到第二帧或结尾：两帧及以上为动图；途中的图形控制扩展带透明标志则有透明。
fn gif_frames(r: &mut Src, head: &mut Head) -> Option<()> {
    let mut frames = 0;
    loop {
        match read_arr::<1>(r)?[0] {
            0x21 => {
                if read_arr::<1>(r)?[0] == 0xF9 {
                    let gce = read_arr::<2>(r)?;
                    if gce[0] >= 1 && gce[1] & 0x01 != 0 {
                        head.has_alpha = Some(true);
                    }
                    skip(r, u64::from(gce[0]).saturating_sub(1))?;
                }
                skip_sub_blocks(r)?;
            }
            0x2C => {
                frames += 1;
                if frames >= 2 {
                    head.animated = true;
                    return Some(());
                }
                let desc = read_arr::<9>(r)?;
                if desc[8] & 0x80 != 0 {
                    skip(r, 3 << ((desc[8] & 0x07) + 1))?;
                }
                skip(r, 1)?;
                skip_sub_blocks(r)?;
            }
            _ => return Some(()),
        }
    }
}

fn skip_sub_blocks(r: &mut Src) -> Option<()> {
    loop {
        let len = read_arr::<1>(r)?[0];
        if len == 0 {
            return Some(());
        }
        skip(r, u64::from(len))?;
    }
}

/// BMP：信息头里的位数、像素密度；32 位且带非零 alpha 掩码才算有透明。
fn bmp_head(r: &mut Src, head: &mut Head) -> Option<()> {
    skip(r, 10)?;
    let size = u32_le(&read_arr::<4>(r)?);
    let (bpp, alpha) = if size == 12 {
        let core = read_arr::<8>(r)?;
        (u16::from_le_bytes([core[6], core[7]]), false)
    } else if size >= 40 {
        let info = read_arr::<36>(r)?;
        let bpp = u16::from_le_bytes([info[10], info[11]]);
        head.dpi = ppm_to_dpi(u32_le(&info[20..]), u32_le(&info[24..]));
        // V3 及以上的信息头在偏移 52（相对信息头起点）处有 alpha 掩码
        let alpha = size >= 56 && {
            skip(r, 52 - 40)?;
            u32_le(&read_arr::<4>(r)?) != 0
        };
        (bpp, alpha)
    } else {
        return None;
    };
    (head.color, head.bit_depth) = match bpp {
        1 | 2 | 4 | 8 => (Some("Indexed"), Some(bpp as u8)),
        16 => (Some("RGB"), None),
        24 => (Some("RGB"), Some(8)),
        32 if alpha => (Some("RGBA"), Some(8)),
        32 => (Some("RGB"), Some(8)),
        _ => (None, None),
    };
    head.has_alpha = head.color.map(|_| alpha);
    Some(())
}

/// 解析 TIFF 结构的 EXIF；某些项损坏时保留能读出的部分。
fn parse_exif(blob: &[u8]) -> Option<Exif> {
    let mut reader = exif::Reader::new();
    reader.continue_on_error(true);
    reader
        .read_raw(blob.to_vec())
        .or_else(|e| e.distill_partial_result(|_| {}))
        .ok()
}

fn field(exif: &Exif, tag: Tag) -> Option<&Value> {
    exif.get_field(tag, In::PRIMARY).map(|f| &f.value)
}

fn uint(exif: &Exif, tag: Tag) -> Option<u32> {
    field(exif, tag)?.get_uint(0)
}

fn rational(exif: &Exif, tag: Tag) -> Option<f64> {
    let v = match field(exif, tag)? {
        Value::Rational(v) => v.first()?.to_f64(),
        Value::SRational(v) => v.first()?.to_f64(),
        _ => return None,
    };
    v.is_finite().then_some(v)
}

fn ascii(exif: &Exif, tag: Tag) -> Option<String> {
    let Value::Ascii(parts) = field(exif, tag)? else {
        return None;
    };
    let s = String::from_utf8_lossy(parts.first()?);
    let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!s.is_empty()).then(|| s.to_owned())
}

/// 去掉多余的小数位：2.8 → "2.8"，50.0 → "50"。
fn decimal(v: f64) -> String {
    let s = format!("{v:.1}");
    s.strip_suffix(".0").map(str::to_owned).unwrap_or(s)
}

/// EXIF 分辨率（XResolution / YResolution 都在才算）。单位 3 为厘米，其余按英寸。
fn exif_dpi(exif: &Exif) -> Option<(f64, f64)> {
    let x = rational(exif, Tag::XResolution)?;
    let y = rational(exif, Tag::YResolution)?;
    let scale = if uint(exif, Tag::ResolutionUnit) == Some(3) {
        2.54
    } else {
        1.0
    };
    (x > 0.0 && y > 0.0).then_some((x * scale, y * scale))
}

fn exif_items(exif: &Exif) -> Vec<ExifItem> {
    EXIF_KEYS
        .iter()
        .filter_map(|&key| {
            let value = match key {
                "make" => ascii(exif, Tag::Make),
                "model" => ascii(exif, Tag::Model),
                "lens" => ascii(exif, Tag::LensModel),
                "dateTime" => {
                    ascii(exif, Tag::DateTimeOriginal).or_else(|| ascii(exif, Tag::DateTime))
                }
                "exposure" => rational(exif, Tag::ExposureTime)
                    .filter(|t| *t > 0.0)
                    .map(|t| {
                        // 1/t 四舍五入后不到 2（如 0.8 s）写成 "1/1 s" 不对，改用秒数
                        if t < 1.0 && (1.0 / t).round() >= 2.0 {
                            format!("1/{} s", (1.0 / t).round())
                        } else {
                            format!("{} s", decimal(t))
                        }
                    }),
                "fNumber" => rational(exif, Tag::FNumber).map(|f| format!("f/{}", decimal(f))),
                "iso" => uint(exif, Tag::PhotographicSensitivity).map(|n| n.to_string()),
                "focalLength" => {
                    rational(exif, Tag::FocalLength).map(|f| format!("{} mm", decimal(f)))
                }
                _ => None,
            }?;
            Some(ExifItem {
                key: key.to_owned(),
                value,
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod testimg {
    //! 测试用的图片构造：手工拼 EXIF（TIFF 结构）并塞进 JPEG / PNG / WebP 容器。

    use glance_imaging::{RgbaView, encode_jpeg, encode_png_lossless, encode_webp};

    #[derive(Clone, Copy)]
    pub enum V {
        Ascii(&'static str),
        Short(u16),
        Long(u32),
        Rational(u32, u32),
    }

    pub const MAKE: u16 = 0x010F;
    pub const MODEL: u16 = 0x0110;
    pub const ORIENTATION: u16 = 0x0112;
    pub const EXIF_IFD: u16 = 0x8769;
    pub const ISO: u16 = 0x8827;

    /// 小端 TIFF：IFD0 放 ifd0 的项；exif 非空时另建 Exif IFD 并在 IFD0 里指向它。
    pub fn tiff(ifd0: &[(u16, V)], exif: &[(u16, V)]) -> Vec<u8> {
        let mut first: Vec<(u16, V)> = ifd0.to_vec();
        if !exif.is_empty() {
            first.push((EXIF_IFD, V::Long(0)));
        }
        first.sort_by_key(|(t, _)| *t);
        let mut out = b"II*\0\x08\0\0\0".to_vec();
        let probe = ifd(&first, 8);
        if !exif.is_empty() {
            let at = 8 + probe.len() as u32;
            for e in &mut first {
                if e.0 == EXIF_IFD {
                    e.1 = V::Long(at);
                }
            }
            out.extend(ifd(&first, 8));
            let mut sub = exif.to_vec();
            sub.sort_by_key(|(t, _)| *t);
            out.extend(ifd(&sub, at));
        } else {
            out.extend(probe);
        }
        out
    }

    /// 一个 IFD 及其外置数据；at 是它在 TIFF 里的绝对偏移。
    fn ifd(entries: &[(u16, V)], at: u32) -> Vec<u8> {
        let mut head = (entries.len() as u16).to_le_bytes().to_vec();
        let mut data: Vec<u8> = Vec::new();
        let data_at = at + 2 + 12 * entries.len() as u32 + 4;
        for (tag, v) in entries {
            head.extend(tag.to_le_bytes());
            let (typ, count, bytes): (u16, u32, Vec<u8>) = match v {
                V::Ascii(s) => {
                    let mut b = s.as_bytes().to_vec();
                    b.push(0);
                    (2, b.len() as u32, b)
                }
                V::Short(n) => (3, 1, n.to_le_bytes().to_vec()),
                V::Long(n) => (4, 1, n.to_le_bytes().to_vec()),
                V::Rational(n, d) => (5, 1, [n.to_le_bytes(), d.to_le_bytes()].concat()),
            };
            head.extend(typ.to_le_bytes());
            head.extend(count.to_le_bytes());
            if bytes.len() <= 4 {
                let mut inline = bytes;
                inline.resize(4, 0);
                head.extend(inline);
            } else {
                head.extend((data_at + data.len() as u32).to_le_bytes());
                data.extend(&bytes);
                if data.len() % 2 == 1 {
                    data.push(0);
                }
            }
        }
        head.extend(0u32.to_le_bytes());
        head.extend(data);
        head
    }

    fn opaque(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| [(i * 7) as u8, (i * 13) as u8, 90, 255])
            .collect()
    }

    pub fn jpeg(w: u32, h: u32) -> Vec<u8> {
        encode_jpeg(
            RgbaView {
                width: w,
                height: h,
                data: &opaque(w, h),
            },
            90,
            [0, 0, 0],
        )
        .unwrap()
    }

    /// 在 SOI 之后插入 EXIF 的 APP1 段。
    pub fn jpeg_with_exif(w: u32, h: u32, tiff: &[u8]) -> Vec<u8> {
        let plain = jpeg(w, h);
        let mut seg = vec![0xFF, 0xE1];
        seg.extend(((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend(b"Exif\0\0");
        seg.extend(tiff);
        [&plain[..2], &seg[..], &plain[2..]].concat()
    }

    pub fn png(w: u32, h: u32) -> Vec<u8> {
        encode_png_lossless(RgbaView {
            width: w,
            height: h,
            data: &opaque(w, h),
        })
        .unwrap()
    }

    /// 颜色和透明度足够多样，编码器不会把它降成调色板或去掉透明通道。
    pub fn rgba_png() -> Vec<u8> {
        let data: Vec<u8> = (0..32u32 * 32)
            .flat_map(|i| {
                [
                    (i % 251) as u8,
                    (i / 7) as u8,
                    (i * 3) as u8,
                    (i % 200) as u8 + 30,
                ]
            })
            .collect();
        encode_png_lossless(RgbaView {
            width: 32,
            height: 32,
            data: &data,
        })
        .unwrap()
    }

    pub fn png_with_exif(w: u32, h: u32, tiff: &[u8]) -> Vec<u8> {
        png_with_chunk(w, h, b"eXIf", tiff)
    }

    /// 在 IHDR 之后插入一个块。
    pub fn png_with_chunk(w: u32, h: u32, kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let plain = png(w, h);
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend(kind);
        chunk.extend(data);
        chunk.extend(crc32(&chunk[4..]).to_be_bytes());
        let after_ihdr = 8 + 4 + 4 + 13 + 4;
        [&plain[..after_ihdr], &chunk[..], &plain[after_ihdr..]].concat()
    }

    /// PNG 块用的 CRC-32（多项式 0xEDB88320）。
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// 扩展格式的 WebP：VP8X（带 EXIF 标志）+ 原有的 VP8 块 + EXIF 块。
    pub fn webp_with_exif(w: u32, h: u32, tiff: &[u8]) -> Vec<u8> {
        let plain = encode_webp(
            RgbaView {
                width: w,
                height: h,
                data: &opaque(w, h),
            },
            80,
        )
        .unwrap();
        assert_eq!(&plain[12..16], b"VP8 ");
        let mut chunks = b"VP8X".to_vec();
        chunks.extend(10u32.to_le_bytes());
        chunks.extend([0x08, 0, 0, 0]);
        chunks.extend(&(w - 1).to_le_bytes()[..3]);
        chunks.extend(&(h - 1).to_le_bytes()[..3]);
        chunks.extend(&plain[12..]);
        chunks.extend(b"EXIF");
        chunks.extend((tiff.len() as u32).to_le_bytes());
        chunks.extend(tiff);
        if tiff.len() % 2 == 1 {
            chunks.push(0);
        }
        let mut out = b"RIFF".to_vec();
        out.extend((4 + chunks.len() as u32).to_le_bytes());
        out.extend(b"WEBP");
        out.extend(chunks);
        out
    }

    /// 1×1、24 位、每米 3780 像素的 BMP。
    pub fn bmp() -> Vec<u8> {
        let mut bmp = b"BM".to_vec();
        bmp.extend(58u32.to_le_bytes());
        bmp.extend([0u8; 4]);
        bmp.extend(54u32.to_le_bytes());
        bmp.extend(40u32.to_le_bytes());
        bmp.extend(1i32.to_le_bytes());
        bmp.extend(1i32.to_le_bytes());
        bmp.extend(1u16.to_le_bytes());
        bmp.extend(24u16.to_le_bytes());
        bmp.extend([0u8; 8]);
        bmp.extend(3780u32.to_le_bytes());
        bmp.extend(3780u32.to_le_bytes());
        bmp.extend([0u8; 8]);
        bmp.extend([10, 20, 30, 0]);
        bmp
    }

    /// 1×1 的 GIF，frames 帧。
    pub fn gif(frames: usize) -> Vec<u8> {
        let mut out = b"GIF89a\x01\x00\x01\x00\x80\x00\x00".to_vec();
        out.extend([0, 0, 0, 255, 255, 255]);
        for _ in 0..frames {
            out.extend([0x21, 0xF9, 4, 0, 10, 0, 0, 0]);
            out.extend([0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
            out.extend([2, 2, 0x44, 0x01, 0]);
        }
        out.push(0x3B);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testimg::*;
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn display_size_swaps_for_orientations_5_to_8() {
        let tmp = tempfile::tempdir().unwrap();
        for (o, want) in [
            (1, (40, 20)),
            (3, (40, 20)),
            (5, (20, 40)),
            (6, (20, 40)),
            (7, (20, 40)),
            (8, (20, 40)),
        ] {
            let t = tiff(&[(ORIENTATION, V::Short(o))], &[]);
            let p = write(
                tmp.path(),
                &format!("o{o}.jpg"),
                &jpeg_with_exif(40, 20, &t),
            );
            assert_eq!(display_size(&p), Some(want), "方向 {o}");
        }
        let plain = write(tmp.path(), "plain.jpg", &jpeg(40, 20));
        assert_eq!(display_size(&plain), Some((40, 20)));
    }

    #[test]
    fn display_size_follows_orientation_in_png_and_webp_like_thumbnails() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tiff(&[(ORIENTATION, V::Short(6))], &[]);
        let p = write(tmp.path(), "o6.png", &png_with_exif(40, 20, &t));
        assert_eq!(display_size(&p), Some((20, 40)));
        let w = write(tmp.path(), "o6.webp", &webp_with_exif(40, 20, &t));
        assert_eq!(display_size(&w), Some((20, 40)));
        // 与缩略图管线实际转正的结果一致
        let j = write(tmp.path(), "o6.jpg", &jpeg_with_exif(40, 20, &t));
        for f in [&p, &w, &j] {
            let thumb = glance_imaging::make_thumbnail(&fs::read(f).unwrap(), 1000).unwrap();
            assert_eq!(display_size(f), Some((thumb.width, thumb.height)), "{f:?}");
        }
    }

    #[test]
    fn display_size_of_png_is_header_size() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.png", &png(4, 2));
        assert_eq!(display_size(&p), Some((4, 2)));
    }

    #[test]
    fn display_size_of_garbage_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "bad.jpg", b"not an image at all");
        assert_eq!(display_size(&p), None);
        assert_eq!(display_size(&tmp.path().join("missing.png")), None);
    }

    #[test]
    fn details_reports_alpha_and_color() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.png", &rgba_png());
        let d = image_details(&p).unwrap();
        assert_eq!(d.color.as_deref(), Some("RGBA"));
        assert_eq!(d.has_alpha, Some(true));
        assert_eq!(d.bit_depth, Some(8));
        assert!(!d.animated);
        assert_eq!(d.path, p.to_string_lossy());
        assert_eq!(
            Some(d.mtime_ms),
            crate::catalog::scan::stamp_of(&p).map(|s| s.mtime_ms)
        );

        let j = write(tmp.path(), "a.jpg", &jpeg(8, 8));
        let d = image_details(&j).unwrap();
        assert_eq!(d.color.as_deref(), Some("RGB"));
        assert_eq!(d.has_alpha, Some(false));
        assert_eq!(d.bit_depth, Some(8));
    }

    #[test]
    fn details_lists_exif_in_fixed_order() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tiff(
            &[(MODEL, V::Ascii("EOS R5")), (MAKE, V::Ascii("Canon"))],
            &[(ISO, V::Short(400))],
        );
        let p = write(tmp.path(), "e.jpg", &jpeg_with_exif(8, 8, &t));
        let d = image_details(&p).unwrap();
        let item = |k: &str, v: &str| ExifItem {
            key: k.into(),
            value: v.into(),
        };
        assert_eq!(
            d.exif,
            vec![
                item("make", "Canon"),
                item("model", "EOS R5"),
                item("iso", "400")
            ]
        );
    }

    #[test]
    fn details_formats_exposure_aperture_and_focal_length() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tiff(
            &[],
            &[
                (0x829A, V::Rational(1, 250)),
                (0x829D, V::Rational(28, 10)),
                (0x920A, V::Rational(50, 1)),
            ],
        );
        let p = write(tmp.path(), "e.jpg", &jpeg_with_exif(8, 8, &t));
        let d = image_details(&p).unwrap();
        let item = |k: &str, v: &str| ExifItem {
            key: k.into(),
            value: v.into(),
        };
        assert_eq!(
            d.exif,
            vec![
                item("exposure", "1/250 s"),
                item("fNumber", "f/2.8"),
                item("focalLength", "50 mm")
            ]
        );
    }

    #[test]
    fn exposure_near_one_second_is_written_in_seconds() {
        let tmp = tempfile::tempdir().unwrap();
        for (i, (num, den, want)) in [
            (1, 1, "1 s"),
            (4, 5, "0.8 s"),
            (3, 5, "1/2 s"),
            (1, 250, "1/250 s"),
        ]
        .into_iter()
        .enumerate()
        {
            let t = tiff(&[], &[(0x829A, V::Rational(num, den))]);
            let p = write(tmp.path(), &format!("x{i}.jpg"), &jpeg_with_exif(8, 8, &t));
            let d = image_details(&p).unwrap();
            assert_eq!(d.exif.len(), 1);
            assert_eq!(d.exif[0].value, want);
        }
    }

    #[test]
    fn details_reads_dpi_from_exif_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tiff(
            &[
                (0x011A, V::Rational(300, 1)),
                (0x011B, V::Rational(300, 1)),
                (0x0128, V::Short(2)),
            ],
            &[],
        );
        let p = write(tmp.path(), "e.webp", &webp_with_exif(8, 8, &t));
        assert_eq!(image_details(&p).unwrap().dpi, Some((300.0, 300.0)));
        let plain = write(tmp.path(), "plain.png", &png(2, 2));
        assert_eq!(image_details(&plain).unwrap().dpi, None);
    }

    #[test]
    fn details_reads_dpi_from_png_phys() {
        let tmp = tempfile::tempdir().unwrap();
        // 每米 5000 / 10000 像素，单位为米
        let phys = [5000u32.to_be_bytes(), 10000u32.to_be_bytes()].concat();
        let p = write(
            tmp.path(),
            "p.png",
            &png_with_chunk(2, 2, b"pHYs", &[&phys[..], &[1]].concat()),
        );
        assert_eq!(image_details(&p).unwrap().dpi, Some((127.0, 254.0)));
    }

    #[test]
    fn details_reads_bmp_info_header() {
        let tmp = tempfile::tempdir().unwrap();
        // 1×1、24 位、每米 3780 像素
        let p = write(tmp.path(), "a.bmp", &bmp());
        let d = image_details(&p).unwrap();
        assert_eq!(
            (d.color.as_deref(), d.bit_depth, d.has_alpha),
            (Some("RGB"), Some(8), Some(false))
        );
        let (x, y) = d.dpi.unwrap();
        assert!((x - 96.012).abs() < 1e-9 && (y - 96.012).abs() < 1e-9);
        assert_eq!(display_size(&p), Some((1, 1)));
    }

    #[test]
    fn details_of_missing_file_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(image_details(&tmp.path().join("gone.png")).is_none());
    }

    #[test]
    fn details_flags_animated_gif() {
        let tmp = tempfile::tempdir().unwrap();
        let two = write(tmp.path(), "two.gif", &gif(2));
        let d = image_details(&two).unwrap();
        assert!(d.animated);
        assert_eq!(d.color.as_deref(), Some("Indexed"));
        let one = write(tmp.path(), "one.gif", &gif(1));
        assert!(!image_details(&one).unwrap().animated);
    }

    #[test]
    fn details_by_id_resolves_through_the_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.png", &png(2, 2));
        let registry = crate::catalog::registry::Registry::default();
        let id = registry.register(&p);
        assert_eq!(
            details_by_id(&registry, id).unwrap().path,
            p.to_string_lossy()
        );
        assert!(details_by_id(&registry, crate::catalog::registry::FileId(999)).is_err());
    }

    /// 各格式的样张（JPEG / PNG / WebP 带 EXIF，GIF 两帧，BMP）。
    fn robustness_samples() -> Vec<(&'static str, Vec<u8>)> {
        let t = tiff(
            &[
                (MAKE, V::Ascii("Canon")),
                (ORIENTATION, V::Short(6)),
                (0x011A, V::Rational(300, 1)),
            ],
            &[(ISO, V::Short(400)), (0x829A, V::Rational(1, 250))],
        );
        vec![
            ("jpg", jpeg_with_exif(8, 8, &t)),
            ("png", png_with_exif(8, 8, &t)),
            ("webp", webp_with_exif(8, 8, &t)),
            ("gif", gif(2)),
            ("bmp", bmp()),
        ]
    }

    #[test]
    fn truncated_files_never_panic() {
        let tmp = tempfile::tempdir().unwrap();
        for (ext, bytes) in robustness_samples() {
            let p = tmp.path().join(format!("t.{ext}"));
            for cut in 0..=bytes.len() {
                fs::write(&p, &bytes[..cut]).unwrap();
                let _ = display_size(&p);
                let _ = image_details(&p);
            }
        }
    }

    #[test]
    fn oversized_length_fields_never_panic() {
        // 依次把每个位置起的 4 个字节改成 0xFF（盖住各处的长度、偏移、计数字段），再改成 0x7F
        let tmp = tempfile::tempdir().unwrap();
        for (ext, bytes) in robustness_samples() {
            let p = tmp.path().join(format!("o.{ext}"));
            for fill in [0xFFu8, 0x7F] {
                for at in 0..bytes.len() {
                    let mut b = bytes.clone();
                    let end = (at + 4).min(b.len());
                    b[at..end].fill(fill);
                    fs::write(&p, &b).unwrap();
                    let _ = display_size(&p);
                    let _ = image_details(&p);
                }
            }
        }
    }
}
