use glance_imaging::{ImagingError, RgbaView, encode_jpeg, encode_png_lossless, encode_webp};

fn gradient(w: u32, h: u32) -> Vec<u8> {
    (0..w * h).flat_map(|i| [(i % w) as u8, (i / w) as u8, 128, 255]).collect()
}

#[test]
fn each_encoder_roundtrips_dimensions() {
    let data = gradient(64, 48);
    let view = || RgbaView { width: 64, height: 48, data: &data };
    for bytes in [
        encode_jpeg(view(), 80, [255, 255, 255], None, None).unwrap(),
        encode_webp(view(), 80, None, None).unwrap(),
        encode_png_lossless(view(), None).unwrap(),
    ] {
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (64, 48));
    }
}

#[test]
fn png_lossless_preserves_pixels() {
    let data = gradient(32, 32);
    let bytes = encode_png_lossless(RgbaView { width: 32, height: 32, data: &data }, None).unwrap();
    assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8().into_raw(), data);
}

#[test]
fn jpeg_fills_transparent_pixels() {
    let data = vec![0u8; 16 * 16 * 4]; // 全透明
    let bytes = encode_jpeg(RgbaView { width: 16, height: 16, data: &data }, 95, [255, 0, 0], None, None).unwrap();
    let px = image::load_from_memory(&bytes).unwrap().to_rgb8().get_pixel(8, 8).0;
    assert!(px[0] > 240 && px[1] < 15 && px[2] < 15, "{px:?}");
}

#[test]
fn lower_quality_is_smaller() {
    let data = gradient(256, 256);
    let v = || RgbaView { width: 256, height: 256, data: &data };
    assert!(encode_jpeg(v(), 30, [0; 3], None, None).unwrap().len() < encode_jpeg(v(), 90, [0; 3], None, None).unwrap().len());
    assert!(encode_webp(v(), 30, None, None).unwrap().len() < encode_webp(v(), 90, None, None).unwrap().len());
}

#[test]
fn rejects_bad_input_without_panicking() {
    let data = vec![0u8; 10];
    let bad = [(0, 4), (4, 0), (4, 4)]; // 最后一项长度不符
    for (w, h) in bad {
        let v = || RgbaView { width: w, height: h, data: &data };
        assert!(matches!(encode_jpeg(v(), 80, [0; 3], None, None), Err(ImagingError::InvalidBuffer { .. })));
        assert!(matches!(encode_webp(v(), 80, None, None), Err(ImagingError::InvalidBuffer { .. })));
        assert!(matches!(encode_png_lossless(v(), None), Err(ImagingError::InvalidBuffer { .. })));
    }
    let ok = vec![0u8; 4 * 4 * 4];
    let v = || RgbaView { width: 4, height: 4, data: &ok };
    assert!(matches!(encode_jpeg(v(), 0, [0; 3], None, None), Err(ImagingError::InvalidQuality(0))));
    assert!(matches!(encode_webp(v(), 101, None, None), Err(ImagingError::InvalidQuality(101))));
}

#[test]
fn huge_dimensions_do_not_overflow() {
    let data = vec![0u8; 16];
    let v = RgbaView { width: u32::MAX, height: u32::MAX, data: &data };
    assert!(matches!(encode_png_lossless(v, None), Err(ImagingError::InvalidBuffer { .. })));
}
