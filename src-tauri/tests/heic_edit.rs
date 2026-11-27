//! 现编一张带拍摄信息（厂商、方向）的 HEIC，经 `render_path` 转成 JPEG：输出是 JPEG，
//! EXIF 里的厂商保留、方向为 1、像素尺寸等于输出尺寸。
//! 编码器不可用的机器（CI 可能如此）打印原因后直接返回，不算失败。
#![cfg(target_os = "macos")]

use std::ffi::c_void;

use glance_imaging::{EditParams, OutFormat, SrcFormat};
use glance_lib::edit::render::render_path;
use objc2_core_foundation::{
    CFArray, CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImageAlphaInfo,
    kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageDestination, kCGImageDestinationLossyCompressionQuality, kCGImagePropertyExifDictionary,
    kCGImagePropertyExifPixelXDimension, kCGImagePropertyExifPixelYDimension,
    kCGImagePropertyOrientation, kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFMake,
};

const W: u32 = 64;
const H: u32 = 48;

/// W×H 的不透明渐变编成 HEIC，带厂商 `Acme` 与方向 6（顺时针 90°）；编码器不可用时返回 Err(原因)。
fn heic_with_exif() -> Result<Vec<u8>, String> {
    let mut px = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            px.extend_from_slice(&[(x * 4) as u8, (y * 5) as u8, 128, 255]);
        }
    }
    let uti = CFString::from_str("public.heic");
    // SAFETY: 同 heic_display：位图上下文借用 `px` 的缓冲，宽高与行字节数一致，
    // 上下文与由它生成的 CGImage 都在 `px` 释放前用完。
    unsafe {
        let available = CGImageDestination::type_identifiers();
        let available: &CFArray<CFType> = available.cast_unchecked();
        if !available
            .iter()
            .any(|t| t.downcast_ref::<CFString>().is_some_and(|s| *s == *uti))
        {
            return Err("本机 CGImageDestination 不支持 public.heic".into());
        }
        let space = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)).ok_or("没有 sRGB")?;
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
            .ok_or("CGImageDestination 不接受 HEIC")?;
        let quality = CFNumber::new_f64(0.9);
        let make = CFString::from_str("Acme");
        let tiff: CFRetained<CFDictionary<CFString, CFType>> =
            CFDictionary::from_slices(&[kCGImagePropertyTIFFMake], &[make.as_ref()]);
        // 源里带上（原始、转正前的）像素尺寸：输出时应被改写成输出尺寸。
        let (px_w, px_h) = (CFNumber::new_i32(W as i32), CFNumber::new_i32(H as i32));
        let exif_dict: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
            &[
                kCGImagePropertyExifPixelXDimension,
                kCGImagePropertyExifPixelYDimension,
            ],
            &[px_w.as_ref(), px_h.as_ref()],
        );
        let orientation = CFNumber::new_i32(6);
        let opts: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
            &[
                kCGImageDestinationLossyCompressionQuality,
                kCGImagePropertyOrientation,
                kCGImagePropertyTIFFDictionary,
                kCGImagePropertyExifDictionary,
            ],
            &[
                quality.as_ref(),
                orientation.as_ref(),
                tiff.as_ref(),
                exif_dict.as_ref(),
            ],
        );
        dest.add_image(&image, Some(opts.as_opaque()));
        if !dest.finalize() {
            return Err("HEIC 编码失败（finalize 返回 false）".into());
        }
        Ok(data.to_vec())
    }
}

#[test]
fn heic_converts_to_jpeg_with_exif() {
    let bytes = match heic_with_exif() {
        Ok(b) => b,
        Err(why) => {
            eprintln!("跳过：{why}");
            return;
        }
    };
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("IMG_1.heic");
    std::fs::write(&file, &bytes).unwrap();

    let params = EditParams::Convert {
        format: OutFormat::Jpeg,
        quality: 90,
        fill: [255; 3],
    };
    let (enc, src, _) = render_path(&file, &params).expect("HEIC 应能转成 JPEG");
    assert_eq!(src, SrcFormat::Heif);
    assert_eq!(enc.format, OutFormat::Jpeg);
    assert_eq!(&enc.bytes[..2], &[0xFF, 0xD8]);
    // 方向由解码转正：输出的像素尺寸与解码出的一致（64×48 或转正后的 48×64）。
    let mut dims = [enc.width, enc.height];
    dims.sort_unstable();
    assert_eq!(dims, [H, W]);

    let x = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(&enc.bytes))
        .expect("输出 JPEG 应带 EXIF");
    let text = |t| {
        x.get_field(t, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
    };
    let uint = |t| {
        x.get_field(t, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
    };
    assert_eq!(text(exif::Tag::Make).as_deref(), Some("\"Acme\""));
    assert_eq!(uint(exif::Tag::Orientation), Some(1));
    let jpeg = imagesize::blob_size(&enc.bytes).unwrap();
    assert_eq!(
        (jpeg.width, jpeg.height),
        (enc.width as usize, enc.height as usize)
    );
    assert_eq!(uint(exif::Tag::PixelXDimension), Some(enc.width));
    assert_eq!(uint(exif::Tag::PixelYDimension), Some(enc.height));
}
