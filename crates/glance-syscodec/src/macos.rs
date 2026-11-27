//! macOS：ImageIO 解码，CoreGraphics 画进 8 位 RGBA 位图。
//!
//! 每次调用自建 CGImageSource 与位图上下文，不共享可变状态，可在多个后台线程并发调用。

use std::ffi::c_void;
use std::sync::OnceLock;

use objc2_core_foundation::{
    CFArray, CFBoolean, CFData, CFDictionary, CFIndex, CFNumber, CFRetained, CFString, CFType,
    CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGColorSpaceModel, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageSource, CGImageSourceStatus, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceThumbnailMaxPixelSize, kCGImageSourceTypeIdentifierHint,
};

use crate::{CodecError, Image, Kind, boxes_complete, unpremultiply};

const UTI_HEIC: &str = "public.heic";
const UTI_HEIF: &str = "public.heif";
const UTI_AVIF: &str = "public.avif";

pub(crate) fn decode(
    bytes: &[u8],
    kind: Kind,
    max_pixels: u64,
    max_edge: Option<u32>,
) -> Result<Image, CodecError> {
    if !os_supports(kind) {
        return Err(CodecError::NoCodec);
    }
    if !boxes_complete(bytes) {
        // 截断的文件，ImageIO 常常照样画出半张图（缺的部分是灰的）、状态也报完整；一律算读不出。
        return Err(err("文件不完整或已损坏"));
    }
    let source = create_source(bytes, kind).ok_or_else(|| err("建不出图像源"))?;
    let index = primary_index(&source).ok_or_else(|| err("文件里没有图像"))?;
    if !is_complete(&source, index) {
        return Err(err("文件不完整或已损坏"));
    }
    let (w, h) = pixel_dims(&source, index).ok_or_else(|| err("读不出尺寸"))?;
    let long = w.max(h);
    let target = match max_edge {
        Some(edge) => edge.clamp(1, long),
        None if u64::from(w) * u64::from(h) > max_pixels => return Err(CodecError::TooLarge),
        None => long,
    };
    let image = oriented_image(&source, index, target).ok_or_else(|| err("解码失败"))?;
    if max_edge.is_none() {
        // 属性里的尺寸可能与实际编码的图不符：按解出来的图再核一次，免得超限分配。
        let actual = (CGImage::width(Some(&image)) as u64)
            .saturating_mul(CGImage::height(Some(&image)) as u64);
        if actual > max_pixels {
            return Err(CodecError::TooLarge);
        }
    }
    render(&image)
}

fn err(msg: &str) -> CodecError {
    CodecError::Decode(msg.to_owned())
}

/// 本机 ImageIO 能否读这种格式；结果只算一次。
fn os_supports(kind: Kind) -> bool {
    static SUPPORTED: OnceLock<(bool, bool)> = OnceLock::new();
    let (heif, avif) = *SUPPORTED.get_or_init(|| {
        // SAFETY: 无参数的查询函数，返回本进程持有的新数组。
        let ids = unsafe { CGImageSource::type_identifiers() };
        // SAFETY: 数组里放的都是 CF 对象，按 CFType 读取总是合法；下面逐个检查是不是 CFString。
        let ids: &CFArray<CFType> = unsafe { ids.cast_unchecked() };
        let has = |uti: &str| {
            let uti = CFString::from_str(uti);
            ids.iter()
                .any(|t| t.downcast_ref::<CFString>().is_some_and(|s| *s == *uti))
        };
        (has(UTI_HEIC) || has(UTI_HEIF), has(UTI_AVIF))
    });
    match kind {
        Kind::Heif => heif,
        Kind::Avif => avif,
    }
}

/// 从内存字节建图像源（字节会复制一份交给 CoreFoundation，调用返回后不再引用 `bytes`）。
fn create_source(bytes: &[u8], kind: Kind) -> Option<CFRetained<CGImageSource>> {
    let len = CFIndex::try_from(bytes.len()).ok()?;
    // SAFETY: 指针与长度来自同一个切片；CFDataCreate 立即复制这些字节。
    let data = unsafe { CFData::new(None, bytes.as_ptr(), len) }?;
    let hint = CFString::from_str(match kind {
        Kind::Heif => UTI_HEIC,
        Kind::Avif => UTI_AVIF,
    });
    // SAFETY: 读取 ImageIO 导出的常量字符串。
    let key = unsafe { kCGImageSourceTypeIdentifierHint };
    let opts: CFRetained<CFDictionary<CFString, CFType>> =
        CFDictionary::from_slices(&[key], &[hint.as_ref()]);
    // SAFETY: `opts` 的键值都是 CFString / CF 对象，符合该函数对选项字典的要求。
    unsafe { CGImageSource::with_data(&data, Some(opts.as_opaque())) }
}

/// 主图的索引；源里没有图像时为 None。
fn primary_index(source: &CGImageSource) -> Option<usize> {
    // SAFETY: `source` 是有效的图像源；两个查询都只读。
    let (count, primary) = unsafe { (source.count(), source.primary_image_index()) };
    if count == 0 {
        None
    } else if primary < count {
        Some(primary)
    } else {
        Some(0)
    }
}

/// 整个源与主图都读到了完整数据。
fn is_complete(source: &CGImageSource, index: usize) -> bool {
    // SAFETY: `index` 已确认小于图像数；两个查询都只读。
    let (all, one) = unsafe { (source.status(), source.status_at_index(index)) };
    all == CGImageSourceStatus::StatusComplete && one == CGImageSourceStatus::StatusComplete
}

/// 图像属性里的像素宽高（未缩小）。
fn pixel_dims(source: &CGImageSource, index: usize) -> Option<(u32, u32)> {
    // SAFETY: `index` 已确认小于图像数；不传选项。
    let props = unsafe { source.properties_at_index(index, None) }?;
    // SAFETY: 图像属性字典的键是 CFString，值是 CF 对象；取值后再按类型检查。
    let props: &CFDictionary<CFString, CFType> = unsafe { props.cast_unchecked() };
    let dim = |key: &CFString| -> Option<u32> {
        let v = props.get(key)?;
        let n = v.downcast_ref::<CFNumber>()?.as_i64()?;
        u32::try_from(n).ok().filter(|&n| n > 0)
    };
    // SAFETY: 读取 ImageIO 导出的常量字符串。
    let (wk, hk) = unsafe { (kCGImagePropertyPixelWidth, kCGImagePropertyPixelHeight) };
    Some((dim(wk)?, dim(hk)?))
}

/// 按文件记录的方向摆正、长边不超过 `max_edge` 的图像。
fn oriented_image(
    source: &CGImageSource,
    index: usize,
    max_edge: u32,
) -> Option<CFRetained<CGImage>> {
    let yes = CFBoolean::new(true);
    let size = CFNumber::new_i64(i64::from(max_edge));
    // SAFETY: 读取 ImageIO 导出的常量字符串。
    let keys = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ]
    };
    let values: [&CFType; 3] = [yes.as_ref(), yes.as_ref(), size.as_ref()];
    let opts: CFRetained<CFDictionary<CFString, CFType>> =
        CFDictionary::from_slices(&keys, &values);
    // SAFETY: `index` 已确认小于图像数；选项字典的键值类型符合文档要求。
    unsafe { source.thumbnail_at_index(index, Some(opts.as_opaque())) }
}

/// 画进 8 位预乘 RGBA 位图，再还原成非预乘。
fn render(image: &CGImage) -> Result<Image, CodecError> {
    let w = CGImage::width(Some(image));
    let h = CGImage::height(Some(image));
    let (Ok(width), Ok(height)) = (u32::try_from(w), u32::try_from(h)) else {
        return Err(err("尺寸超出范围"));
    };
    if width == 0 || height == 0 {
        return Err(err("尺寸为 0"));
    }
    let row = w.checked_mul(4).ok_or_else(|| err("尺寸超出范围"))?;
    let len = row.checked_mul(h).ok_or_else(|| err("尺寸超出范围"))?;
    let mut rgba = Vec::new();
    rgba.try_reserve_exact(len).map_err(|_| err("内存不足"))?;
    rgba.resize(len, 0);

    let (space, mut icc) = target_space(image).ok_or_else(|| err("没有可用的色彩空间"))?;
    if !draw_rgba(&mut rgba, w, h, &space, image) {
        // 源空间做不了 8 位位图的输出空间时退回 sRGB。
        icc = None;
        let srgb = srgb().ok_or_else(|| err("没有 sRGB"))?;
        if !draw_rgba(&mut rgba, w, h, &srgb, image) {
            return Err(err("建不出位图"));
        }
    }

    unpremultiply(&mut rgba);
    Ok(Image {
        width,
        height,
        rgba,
        icc,
    })
}

fn srgb() -> Option<CFRetained<CGColorSpace>> {
    // SAFETY: 读取 CoreGraphics 导出的常量字符串。
    CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
}

/// 位图的色彩空间与要返回的 ICC：源是 RGB、带 ICC、不是 PQ / HLG 且不是 sRGB 时保持源空间；
/// 否则画到 sRGB，ICC 为 None。
fn target_space(image: &CGImage) -> Option<(CFRetained<CGColorSpace>, Option<Vec<u8>>)> {
    if let Some(space) = CGImage::color_space(Some(image)) {
        let keep = CGColorSpace::model(Some(&space)) == CGColorSpaceModel::RGB
            && !space.uses_itur_2100_tf()
            && space.supports_output()
            && !is_srgb(&space);
        if keep && let Some(icc) = CGColorSpace::icc_data(Some(&space)).filter(|d| !d.is_empty()) {
            return Some((space, Some(icc.to_vec())));
        }
    }
    Some((srgb()?, None))
}

fn is_srgb(space: &CGColorSpace) -> bool {
    // SAFETY: 读取 CoreGraphics 导出的常量字符串。
    let srgb = unsafe { kCGColorSpaceSRGB };
    CGColorSpace::name(Some(space)).is_some_and(|n| *n == *srgb)
}

/// 以 `buf`（w × h 的紧排 RGBA8，行宽 w × 4）为像素缓冲建 8 位预乘 RGBA 位图上下文，
/// 把 `image` 铺满画进去。建不出上下文（如 `space` 不能做输出空间）时返回 false。
/// 上下文只在本函数内存在，`buf` 的可变借用覆盖它的整个生命期。
fn draw_rgba(buf: &mut [u8], w: usize, h: usize, space: &CGColorSpace, image: &CGImage) -> bool {
    let Some(row) = w.checked_mul(4) else {
        return false;
    };
    if row.checked_mul(h).is_none_or(|need| buf.len() < need) {
        return false;
    }
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    let data: *mut c_void = buf.as_mut_ptr().cast();
    // SAFETY: `buf` 至少有 row × h 字节，行宽 row = w × 4 与 8 位 RGBA 一致；
    // 上下文在本函数返回前释放，期间 `buf` 被可变借用，别处读写不到它。
    let Some(ctx) = (unsafe { CGBitmapContextCreate(data, w, h, 8, row, Some(space), info) })
    else {
        return false;
    };
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
    CGContext::draw_image(Some(&ctx), rect, Some(image));
    true
}
