//! 用 CGImageDestination 现编一张 HEIC / AVIF，再交给 `decode` 解回来比对。
//! 编码器不可用的机器（CI 可能如此）打印原因后直接返回，不算失败。
#![cfg(target_os = "macos")]

use std::ffi::c_void;

use glance_syscodec::{CodecError, Kind, decode};
use objc2_core_foundation::{CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImageAlphaInfo,
    kCGColorSpaceDisplayP3, kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageDestination, kCGImageDestinationLossyCompressionQuality, kCGImagePropertyOrientation,
};

const W: u32 = 64;
const H: u32 = 48;

/// 64×48 的渐变：R 随 x、G 随 y，B 固定，不透明。
fn gradient() -> Vec<u8> {
    let mut px = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            px.extend_from_slice(&[(x * 4) as u8, (y * 5) as u8, 128, 255]);
        }
    }
    px
}

/// 把 `gradient()`（标为 `space` 色彩空间、带可选的 EXIF 方向）编成 `uti` 指定的格式；
/// 编码器不可用时返回 Err(原因)。
fn encode(uti: &str, space: &CFString, orientation: Option<i64>) -> Result<Vec<u8>, String> {
    let mut px = gradient();
    let uti = CFString::from_str(uti);
    // SAFETY: 位图上下文借用 `px` 的缓冲，宽高与行字节数与缓冲一致；
    // 上下文与由它生成的 CGImage（CoreGraphics 会复制像素）都在 `px` 释放前用完。
    unsafe {
        let available = CGImageDestination::type_identifiers();
        let available: &objc2_core_foundation::CFArray<CFType> = available.cast_unchecked();
        if !available
            .iter()
            .any(|t| t.downcast_ref::<CFString>().is_some_and(|s| *s == *uti))
        {
            return Err(format!("本机 CGImageDestination 不支持 {uti}"));
        }
        let space = CGColorSpace::with_name(Some(space)).ok_or("没有该色彩空间")?;
        let ctx = CGBitmapContextCreate(
            px.as_mut_ptr() as *mut c_void,
            W as usize,
            H as usize,
            8,
            (W * 4) as usize,
            Some(&space),
            CGImageAlphaInfo::NoneSkipLast.0,
        )
        .ok_or("建位图上下文失败")?;
        let image = CGBitmapContextCreateImage(Some(&ctx)).ok_or("取 CGImage 失败")?;
        let data = CFMutableData::new(None, 0).ok_or("建 CFMutableData 失败")?;
        let dest = CGImageDestination::with_data(&data, &uti, 1, None)
            .ok_or_else(|| format!("CGImageDestination 不接受 {uti}"))?;
        // 质量 1.0（无损）时本机的 AVIF 编码器 finalize 失败，用 0.9。
        let quality = CFNumber::new_f64(0.9);
        let orient = CFNumber::new_i64(orientation.unwrap_or(1));
        let opts: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
            &[
                kCGImageDestinationLossyCompressionQuality,
                kCGImagePropertyOrientation,
            ],
            &[quality.as_ref(), orient.as_ref()],
        );
        dest.add_image(&image, Some(opts.as_opaque()));
        if !dest.finalize() {
            return Err(format!("{uti} 编码失败（finalize 返回 false）"));
        }
        Ok(data.to_vec())
    }
}

fn sample(uti: &str) -> Option<Vec<u8>> {
    // SAFETY: 读取 CoreGraphics 导出的常量字符串。
    sample_with(uti, unsafe { kCGColorSpaceSRGB }, None)
}

fn sample_with(uti: &str, space: &CFString, orientation: Option<i64>) -> Option<Vec<u8>> {
    match encode(uti, space, orientation) {
        Ok(b) => Some(b),
        Err(why) => {
            eprintln!("跳过：{why}");
            None
        }
    }
}

fn px(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

fn assert_corners_close(img: &glance_syscodec::Image) {
    let src = gradient();
    for (x, y) in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)] {
        let a = px(&src, W, x, y);
        let b = px(&img.rgba, img.width, x, y);
        for c in 0..4 {
            let d = (a[c] as i32 - b[c] as i32).abs();
            assert!(d <= 12, "({x},{y}) 通道 {c}：原图 {a:?}，解码 {b:?}");
        }
    }
}

#[test]
fn heic_roundtrip_dims_and_pixels() {
    let Some(bytes) = sample("public.heic") else {
        return;
    };
    let img = decode(&bytes, Kind::Heif, u64::MAX, None).expect("解码 HEIC");
    assert_eq!((img.width, img.height), (W, H));
    assert_eq!(img.rgba.len(), (W * H * 4) as usize);
    assert_corners_close(&img);
}

#[test]
fn avif_roundtrip() {
    let Some(bytes) = sample("public.avif") else {
        return;
    };
    let img = decode(&bytes, Kind::Avif, u64::MAX, None).expect("解码 AVIF");
    assert_eq!((img.width, img.height), (W, H));
    assert_eq!(img.rgba.len(), (W * H * 4) as usize);
    assert_corners_close(&img);
}

#[test]
fn max_edge_downscales() {
    let Some(bytes) = sample("public.heic") else {
        return;
    };
    let img = decode(&bytes, Kind::Heif, u64::MAX, Some(16)).expect("解码 HEIC");
    assert_eq!((img.width, img.height), (16, 12));
    assert_eq!(img.rgba.len(), 16 * 12 * 4);
}

#[test]
fn too_large_without_max_edge() {
    let Some(bytes) = sample("public.heic") else {
        return;
    };
    assert_eq!(
        decode(&bytes, Kind::Heif, 100, None).err(),
        Some(CodecError::TooLarge)
    );
    let img = decode(&bytes, Kind::Heif, 100, Some(8)).expect("给了 max_edge 就缩小");
    assert_eq!((img.width, img.height), (8, 6));
}

#[test]
fn srgb_source_has_no_icc() {
    let Some(bytes) = sample("public.heic") else {
        return;
    };
    let img = decode(&bytes, Kind::Heif, u64::MAX, None).expect("解码 HEIC");
    assert_eq!(img.icc, None);
}

#[test]
fn display_p3_source_keeps_space_and_icc() {
    // SAFETY: 读取 CoreGraphics 导出的常量字符串。
    let p3 = unsafe { kCGColorSpaceDisplayP3 };
    let Some(bytes) = sample_with("public.heic", p3, None) else {
        return;
    };
    let img = decode(&bytes, Kind::Heif, u64::MAX, None).expect("解码 HEIC");
    let icc = img.icc.as_ref().expect("非 sRGB 的源应带回 ICC");
    assert!(icc.len() > 128, "ICC 太短：{} 字节", icc.len());
    // 像素留在 P3，不换算到 sRGB：数值应与编码前接近。
    assert_corners_close(&img);
}

#[test]
fn exif_orientation_is_applied() {
    // 6 = 顺时针转 90°：摆正后宽高互换，原图左上角到右上角。
    // SAFETY: 读取 CoreGraphics 导出的常量字符串。
    let srgb = unsafe { kCGColorSpaceSRGB };
    let Some(bytes) = sample_with("public.heic", srgb, Some(6)) else {
        return;
    };
    let img = decode(&bytes, Kind::Heif, u64::MAX, None).expect("解码 HEIC");
    assert_eq!((img.width, img.height), (H, W));
    let src = gradient();
    let a = px(&src, W, 0, 0);
    let b = px(&img.rgba, img.width, H - 1, 0);
    for c in 0..4 {
        assert!(
            (a[c] as i32 - b[c] as i32).abs() <= 12,
            "原图左上 {a:?}，摆正后右上 {b:?}"
        );
    }
    let img = decode(&bytes, Kind::Heif, 100, Some(16)).expect("缩小");
    assert_eq!((img.width, img.height), (12, 16));
}

#[test]
fn garbage_is_decode_error() {
    // 合法的 ftyp（heic 品牌），后面是确定性的伪随机字节。
    let mut bytes = vec![0, 0, 0, 24];
    bytes.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
    let mut s: u32 = 0x1234_5678;
    for _ in 0..4096 {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        bytes.push((s >> 24) as u8);
    }
    for kind in [Kind::Heif, Kind::Avif] {
        match decode(&bytes, kind, u64::MAX, None) {
            Err(CodecError::Decode(_)) => {}
            Err(CodecError::NoCodec) => {
                eprintln!("跳过 {kind:?}：本机没有该解码器");
            }
            other => panic!(
                "{kind:?} 期望 Decode，得到 {:?}",
                other.map(|i| (i.width, i.height))
            ),
        }
    }
    // 空输入与极短输入也不 panic。
    for b in [&[][..], &[0u8; 3][..]] {
        assert!(decode(b, Kind::Heif, u64::MAX, None).is_err());
    }
}

#[test]
fn concurrent_decodes_from_worker_threads() {
    let Some(bytes) = sample("public.heic") else {
        return;
    };
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..4)
            .map(|i| {
                let bytes = &bytes;
                s.spawn(move || {
                    for _ in 0..5 {
                        let edge = if i % 2 == 0 { None } else { Some(16) };
                        let img = decode(bytes, Kind::Heif, u64::MAX, edge).expect("解码 HEIC");
                        assert_eq!(img.width.max(img.height), edge.unwrap_or(W));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("工作线程");
        }
    });
}
