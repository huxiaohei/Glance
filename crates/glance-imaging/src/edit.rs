use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, MulDiv, PixelType, ResizeAlg, ResizeOptions, Resizer};
use serde::{Deserialize, Serialize};

use crate::crop::{CropRect, crop_rgba, orient};
use crate::encode::{RgbaView, encode_jpeg, encode_png_lossless, encode_png_lossy, encode_webp};
use crate::error::ImagingError;
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

pub fn apply(
    src: RgbaView,
    src_format: SrcFormat,
    icc: Option<&[u8]>,
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
            let bytes = match out_format {
                OutFormat::Jpeg => encode_jpeg(view, quality, [255; 3], icc)?,
                OutFormat::Webp => encode_webp(view, quality)?,
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
            let bytes = match format {
                OutFormat::Png => encode_png_lossless(src, icc)?,
                OutFormat::Jpeg => encode_jpeg(src, quality, fill, icc)?,
                OutFormat::Webp => encode_webp(src, quality)?,
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
            let oriented = orient(src, quarter_turns, flip_h, flip_v);
            let cropped = crop_rgba(
                RgbaView {
                    width: oriented.width,
                    height: oriented.height,
                    data: &oriented.rgba,
                },
                rect,
            )?;
            let view = RgbaView {
                width: cropped.width,
                height: cropped.height,
                data: &cropped.rgba,
            };
            let (format, bytes) = match src_format {
                SrcFormat::Jpeg => (OutFormat::Jpeg, encode_jpeg(view, 95, [255; 3], icc)?),
                SrcFormat::Webp => (OutFormat::Webp, encode_webp(view, 95)?),
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
