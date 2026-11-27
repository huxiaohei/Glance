//! 现编一张 HEIC，经显示通道与缩略图管线走一遍：`/image/{id}` 出 PNG，`/thumb/{id}/320` 在生成后可取。
//! 编码器不可用的机器（CI 可能如此）打印原因后直接返回，不算失败。
#![cfg(target_os = "macos")]

use std::ffi::c_void;

use glance_lib::catalog::registry::Registry;
use glance_lib::edit::EditState;
use glance_lib::protocol::{Ctx, respond};
use glance_lib::thumbs::worker::{ThumbEvent, process};
use glance_lib::thumbs::{ThumbCache, Tier};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImageAlphaInfo,
    kCGColorSpaceSRGB,
};
use objc2_image_io::{CGImageDestination, kCGImageDestinationLossyCompressionQuality};

const W: u32 = 64;
const H: u32 = 48;

/// W×H 的不透明渐变编成 HEIC；编码器不可用时返回 Err(原因)。
fn heic() -> Result<Vec<u8>, String> {
    let mut px = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            px.extend_from_slice(&[(x * 4) as u8, (y * 5) as u8, 128, 255]);
        }
    }
    let uti = CFString::from_str("public.heic");
    // SAFETY: 位图上下文借用 `px` 的缓冲，宽高与行字节数与缓冲一致；
    // 上下文与由它生成的 CGImage（CoreGraphics 会复制像素）都在 `px` 释放前用完。
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
        let opts: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
            &[kCGImageDestinationLossyCompressionQuality],
            &[quality.as_ref()],
        );
        dest.add_image(&image, Some(opts.as_opaque()));
        if !dest.finalize() {
            return Err("HEIC 编码失败（finalize 返回 false）".into());
        }
        Ok(data.to_vec())
    }
}

#[test]
fn heic_is_displayed_as_png_and_thumbnailed() {
    let bytes = match heic() {
        Ok(b) => b,
        Err(why) => {
            eprintln!("跳过：{why}");
            return;
        }
    };
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.heic");
    std::fs::write(&file, &bytes).unwrap();
    let registry = Registry::default();
    let cache_dir = tempfile::tempdir().unwrap();
    let cache = ThumbCache::new(cache_dir.path().to_path_buf());
    let edit = EditState::default();
    let ctx = Ctx::new(&registry, &cache, &edit);
    let id = registry.register(&file);

    let resp = respond(&ctx, &format!("/image/{}", id.0));
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "image/png");
    assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    let png = glance_imaging::decode_rgba(resp.body(), u64::MAX).expect("应答是可解码的 PNG");
    assert_eq!((png.width, png.height), (W, H));

    let thumb_url = format!("/thumb/{}/320", id.0);
    assert_eq!(respond(&ctx, &thumb_url).status(), 404);
    assert!(matches!(
        process((id, Tier::S), &registry, &cache),
        ThumbEvent::Ready { .. }
    ));
    let resp = respond(&ctx, &thumb_url);
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "image/webp");
    let size = imagesize::blob_size(resp.body()).unwrap();
    assert_eq!((size.width, size.height), (W as usize, H as usize));
}
