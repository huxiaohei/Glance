use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, MulDiv, PixelType, ResizeAlg, ResizeOptions, Resizer};
use serde::{Deserialize, Serialize};

use crate::crop::{CropRect, crop_rgba, orient_view};
use crate::encode::{RgbaView, encode_jpeg, encode_png_lossless, encode_png_lossy, encode_webp};
use crate::error::ImagingError;
use crate::exifblob::normalize_exif;
use crate::removebg::{RemoveBg, remove_bg};
use crate::thumb::Decoded;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SrcFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Bmp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutFormat {
    Png,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PngMode {
    Lossy,
    Lossless,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EditParams {
    #[serde(rename_all = "camelCase")]
    Compress {
        quality: u8,
        max_edge: Option<u32>,
        png_mode: PngMode,
    },
    #[serde(rename_all = "camelCase")]
    Convert {
        format: OutFormat,
        quality: u8,
        fill: [u8; 3],
    },
    #[serde(rename_all = "camelCase")]
    Crop {
        rect: CropRect,
        quarter_turns: u8,
        flip_h: bool,
        flip_v: bool,
    },
    RemoveBg(RemoveBg),
}

#[derive(Debug, Clone)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub format: OutFormat,
    pub width: u32,
    pub height: u32,
}

/// 按文件头判断格式；不认识返回 None。
pub fn src_format_of(bytes: &[u8]) -> Option<SrcFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(SrcFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(SrcFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(SrcFormat::Webp)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(SrcFormat::Gif)
    } else if bytes.starts_with(b"BM") {
        Some(SrcFormat::Bmp)
    } else {
        None
    }
}

fn check_quality(q: u8) -> Result<(), ImagingError> {
    if (1..=100).contains(&q) {
        Ok(())
    } else {
        Err(ImagingError::InvalidQuality(q))
    }
}

/// 长边缩到 max_edge（调用方保证长边 > max_edge），另一边四舍五入且不小于 1。
fn scaled(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let long = u64::from(w.max(h));
    let f = |v: u32| ((u64::from(v) * u64::from(max_edge) + long / 2) / long).max(1) as u32;
    (f(w), f(h))
}

/// Lanczos3 缩放；带透明通道时先预乘再还原，避免透明边缘发黑。
fn resize(img: &RgbaView, (tw, th): (u32, u32)) -> Result<Vec<u8>, ImagingError> {
    let err = |e: &dyn std::fmt::Display| ImagingError::Encode(format!("缩放失败：{e}"));
    let has_alpha = img.data.chunks_exact(4).any(|p| p[3] != 255);
    let mut src = Image::from_vec_u8(img.width, img.height, img.data.to_vec(), PixelType::U8x4)
        .map_err(|e| err(&e))?;
    let mut dst = Image::new(tw, th, PixelType::U8x4);
    let mul_div = MulDiv::new();
    if has_alpha {
        mul_div
            .multiply_alpha_inplace(&mut src)
            .map_err(|e| err(&e))?;
    }
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| err(&e))?;
    if has_alpha {
        mul_div
            .divide_alpha_inplace(&mut dst)
            .map_err(|e| err(&e))?;
    }
    Ok(dst.into_vec())
}

/// 长边缩到不超过 `max_edge`（Lanczos3，带透明时预乘）；本来就不大于它时原样复制。
/// `max_edge` 为 0 返回 `InvalidMaxEdge`。
pub fn downscale(src: RgbaView, max_edge: u32) -> Result<Decoded, ImagingError> {
    if max_edge == 0 {
        return Err(ImagingError::InvalidMaxEdge);
    }
    if src.width.max(src.height) <= max_edge {
        return Ok(Decoded {
            width: src.width,
            height: src.height,
            rgba: src.data.to_vec(),
        });
    }
    let (w, h) = scaled(src.width, src.height, max_edge);
    Ok(Decoded {
        width: w,
        height: h,
        rgba: resize(&src, (w, h))?,
    })
}

/// 对 `width`×`height` 的图执行 `p` 后的输出尺寸（与 [`apply`] 的结果一致），不做计算。
pub fn out_dims(width: u32, height: u32, p: &EditParams) -> (u32, u32) {
    match *p {
        EditParams::Compress {
            max_edge: Some(m), ..
        } if m > 0 && width.max(height) > m => scaled(width, height, m),
        EditParams::Crop { rect, .. } => (rect.w, rect.h),
        _ => (width, height),
    }
}

/// JPEG / WebP 输出带的 EXIF：源图的原始 TIFF 按输出宽高改写（方向 1、像素尺寸、摘缩略图）；
/// PNG 一律不带；没有、读不懂或写不进尺寸时也不带（不算错误）。
fn exif_for(exif: Option<&[u8]>, format: OutFormat, width: u32, height: u32) -> Option<Vec<u8>> {
    match format {
        OutFormat::Png => None,
        OutFormat::Jpeg | OutFormat::Webp => exif.and_then(|t| normalize_exif(t, width, height)),
    }
}

/// 执行一次编辑并编码。`exif` 是源图**原始**的 EXIF（TIFF 结构，不含 `Exif\0\0`），
/// 输出为 JPEG / WebP 时随输出尺寸改写后带上。
pub fn apply(
    src: RgbaView,
    src_format: SrcFormat,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
    p: &EditParams,
) -> Result<Encoded, ImagingError> {
    match *p {
        EditParams::Compress {
            quality,
            max_edge,
            png_mode,
        } => {
            let out_format = match src_format {
                SrcFormat::Png => OutFormat::Png,
                SrcFormat::Jpeg => OutFormat::Jpeg,
                SrcFormat::Webp => OutFormat::Webp,
                SrcFormat::Gif | SrcFormat::Bmp => return Err(ImagingError::Unsupported),
            };
            check_quality(quality)?;
            let resized;
            let (view, w, h) = match max_edge {
                Some(m) if m > 0 && src.width.max(src.height) > m => {
                    let (tw, th) = scaled(src.width, src.height, m);
                    resized = resize(&src, (tw, th))?;
                    (
                        RgbaView {
                            width: tw,
                            height: th,
                            data: &resized,
                        },
                        tw,
                        th,
                    )
                }
                _ => (
                    RgbaView {
                        width: src.width,
                        height: src.height,
                        data: src.data,
                    },
                    src.width,
                    src.height,
                ),
            };
            let exif = exif_for(exif, out_format, w, h);
            let bytes = match out_format {
                OutFormat::Jpeg => encode_jpeg(view, quality, [255; 3], icc, exif.as_deref())?,
                OutFormat::Webp => encode_webp(view, quality, icc, exif.as_deref())?,
                OutFormat::Png => match png_mode {
                    PngMode::Lossy => encode_png_lossy(view, quality, icc)?,
                    PngMode::Lossless => encode_png_lossless(view, icc)?,
                },
            };
            Ok(Encoded {
                bytes,
                format: out_format,
                width: w,
                height: h,
            })
        }
        EditParams::Convert {
            format,
            quality,
            fill,
        } => {
            check_quality(quality)?;
            let (w, h) = (src.width, src.height);
            let exif = exif_for(exif, format, w, h);
            let bytes = match format {
                OutFormat::Png => encode_png_lossless(src, icc)?,
                OutFormat::Jpeg => encode_jpeg(src, quality, fill, icc, exif.as_deref())?,
                OutFormat::Webp => encode_webp(src, quality, icc, exif.as_deref())?,
            };
            Ok(Encoded {
                bytes,
                format,
                width: w,
                height: h,
            })
        }
        EditParams::Crop {
            rect,
            quarter_turns,
            flip_h,
            flip_v,
        } => {
            if quarter_turns > 3 {
                return Err(ImagingError::InvalidParams("旋转圈数必须在 0 到 3 之间"));
            }
            // 不转不翻时直接从输入截取，不先复制整张图
            let oriented = orient_view(src, quarter_turns, flip_h, flip_v);
            let cropped = crop_rgba(oriented.view(), rect)?;
            let view = RgbaView {
                width: cropped.width,
                height: cropped.height,
                data: &cropped.rgba,
            };
            let (format, bytes) = match src_format {
                SrcFormat::Jpeg => {
                    let exif = exif_for(exif, OutFormat::Jpeg, view.width, view.height);
                    let b = encode_jpeg(view, 95, [255; 3], icc, exif.as_deref())?;
                    (OutFormat::Jpeg, b)
                }
                SrcFormat::Webp => {
                    let exif = exif_for(exif, OutFormat::Webp, view.width, view.height);
                    let b = encode_webp(view, 95, icc, exif.as_deref())?;
                    (OutFormat::Webp, b)
                }
                SrcFormat::Png | SrcFormat::Gif | SrcFormat::Bmp => {
                    (OutFormat::Png, encode_png_lossless(view, icc)?)
                }
            };
            Ok(Encoded {
                bytes,
                format,
                width: cropped.width,
                height: cropped.height,
            })
        }
        EditParams::RemoveBg(ref p) => {
            let out = remove_bg(
                RgbaView {
                    width: src.width,
                    height: src.height,
                    data: src.data,
                },
                p,
            )?;
            let bytes = encode_png_lossless(
                RgbaView {
                    width: src.width,
                    height: src.height,
                    data: &out,
                },
                icc,
            )?;
            Ok(Encoded {
                bytes,
                format: OutFormat::Png,
                width: src.width,
                height: src.height,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exifblob::fixtures::{build, exif_of_jpeg, sample, uint};

    fn img(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| [(i % w) as u8, (i / w) as u8, 128, 255])
            .collect()
    }

    fn view(w: u32, h: u32, d: &[u8]) -> RgbaView<'_> {
        RgbaView {
            width: w,
            height: h,
            data: d,
        }
    }

    fn has_exif_app1(b: &[u8]) -> bool {
        b.windows(6).any(|w| w == b"Exif\0\0")
    }

    fn convert_jpeg() -> EditParams {
        EditParams::Convert {
            format: OutFormat::Jpeg,
            quality: 80,
            fill: [255; 3],
        }
    }

    #[test]
    fn jpeg_output_keeps_gps_and_time() {
        let d = img(48, 32);
        let tiff = sample();
        let e = apply(
            view(48, 32, &d),
            SrcFormat::Jpeg,
            None,
            Some(&tiff),
            &convert_jpeg(),
        )
        .unwrap();
        let x = exif_of_jpeg(&e.bytes);
        let lat = x
            .get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
            .unwrap();
        match &lat.value {
            exif::Value::Rational(v) => assert_eq!((v[0].num, v[1].num, v[2].num), (40, 26, 46)),
            _ => panic!("lat type"),
        }
        let t = x
            .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
            .unwrap();
        assert_eq!(t.display_value().to_string(), "2024-05-06 07:08:09");
        assert_eq!(uint(&x, exif::Tag::Orientation, exif::In::PRIMARY), Some(1));
        assert_eq!(
            uint(&x, exif::Tag::PixelXDimension, exif::In::PRIMARY),
            Some(48)
        );
        assert_eq!(
            uint(&x, exif::Tag::PixelYDimension, exif::In::PRIMARY),
            Some(32)
        );
    }

    #[test]
    fn crop_updates_pixel_dims() {
        let d = img(48, 32);
        let tiff = sample();
        let p = EditParams::Crop {
            rect: CropRect {
                x: 4,
                y: 2,
                w: 20,
                h: 10,
            },
            quarter_turns: 0,
            flip_h: false,
            flip_v: false,
        };
        let e = apply(view(48, 32, &d), SrcFormat::Jpeg, None, Some(&tiff), &p).unwrap();
        let x = exif_of_jpeg(&e.bytes);
        assert_eq!(
            uint(&x, exif::Tag::PixelXDimension, exif::In::PRIMARY),
            Some(20)
        );
        assert_eq!(
            uint(&x, exif::Tag::PixelYDimension, exif::In::PRIMARY),
            Some(10)
        );
        assert_eq!(uint(&x, exif::Tag::Orientation, exif::In::PRIMARY), Some(1));
    }

    #[test]
    fn compress_with_max_edge_updates_pixel_dims() {
        let d = img(48, 32);
        let tiff = sample();
        let p = EditParams::Compress {
            quality: 80,
            max_edge: Some(16),
            png_mode: PngMode::Lossless,
        };
        let e = apply(view(48, 32, &d), SrcFormat::Jpeg, None, Some(&tiff), &p).unwrap();
        assert_eq!((e.width, e.height), (16, 11));
        let x = exif_of_jpeg(&e.bytes);
        assert_eq!(
            uint(&x, exif::Tag::PixelXDimension, exif::In::PRIMARY),
            Some(16)
        );
        assert_eq!(
            uint(&x, exif::Tag::PixelYDimension, exif::In::PRIMARY),
            Some(11)
        );
    }

    #[test]
    fn png_output_has_no_exif() {
        let d = img(16, 16);
        let tiff = sample();
        let to_png = EditParams::Convert {
            format: OutFormat::Png,
            quality: 80,
            fill: [255; 3],
        };
        let e = apply(
            view(16, 16, &d),
            SrcFormat::Jpeg,
            None,
            Some(&tiff),
            &to_png,
        )
        .unwrap();
        assert!(!e.bytes.windows(4).any(|w| w == b"eXIf"));
        assert!(!has_exif_app1(&e.bytes));
        let p = EditParams::Compress {
            quality: 80,
            max_edge: None,
            png_mode: PngMode::Lossy,
        };
        let e = apply(view(16, 16, &d), SrcFormat::Png, None, Some(&tiff), &p).unwrap();
        assert!(!e.bytes.windows(4).any(|w| w == b"eXIf"));
    }

    #[test]
    fn webp_output_keeps_exif() {
        let d = img(48, 32);
        let tiff = sample();
        let p = EditParams::Convert {
            format: OutFormat::Webp,
            quality: 80,
            fill: [255; 3],
        };
        let e = apply(view(48, 32, &d), SrcFormat::Jpeg, None, Some(&tiff), &p).unwrap();
        let at = e.bytes.windows(4).position(|w| w == b"EXIF").unwrap();
        let len = u32::from_le_bytes(e.bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let blob = &e.bytes[at + 8..at + 8 + len];
        let x = exif::Reader::new().read_raw(blob.to_vec()).unwrap();
        assert_eq!(
            uint(&x, exif::Tag::PixelXDimension, exif::In::PRIMARY),
            Some(48)
        );
        assert_eq!(uint(&x, exif::Tag::Orientation, exif::In::PRIMARY), Some(1));
    }

    #[test]
    fn oversized_or_broken_exif_is_dropped_not_fatal() {
        let d = img(16, 16);
        // 合法但超过 JPEG 单段上限。
        let big = build(
            false,
            vec![crate::exifblob::fixtures::ascii(
                0x010F,
                &"x".repeat(70_000),
            )],
            vec![],
            vec![],
            None,
        );
        assert!(big.len() > 65_527);
        for blob in [
            big,
            b"garbage bytes, not a tiff".to_vec(),
            b"II*\0\xff\xff\xff\xff".to_vec(),
        ] {
            let e = apply(
                view(16, 16, &d),
                SrcFormat::Jpeg,
                None,
                Some(&blob),
                &convert_jpeg(),
            )
            .unwrap();
            assert!(!has_exif_app1(&e.bytes));
        }
    }
}
