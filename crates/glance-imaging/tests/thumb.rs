use glance_imaging::{decode_rgba, encode_jpeg, encode_png_lossless, make_thumbnail, ImagingError, RgbaView};

fn png(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
    let data: Vec<u8> = px.iter().copied().cycle().take((w * h * 4) as usize).collect();
    encode_png_lossless(RgbaView { width: w, height: h, data: &data }).unwrap()
}
fn decoded(t: &glance_imaging::Thumbnail) -> image::RgbaImage {
    image::load_from_memory(&t.webp).unwrap().to_rgba8()
}

#[test]
fn scales_long_edge_down_keeping_ratio() {
    let t = make_thumbnail(&png(400, 200, [10, 20, 30, 255]), 320).unwrap();
    assert_eq!((t.width, t.height), (320, 160));
    assert_eq!(decoded(&t).dimensions(), (320, 160));
    let t = make_thumbnail(&png(200, 400, [10, 20, 30, 255]), 320).unwrap();
    assert_eq!((t.width, t.height), (160, 320));
}

#[test]
fn never_upscales() {
    let t = make_thumbnail(&png(100, 50, [1, 2, 3, 255]), 320).unwrap();
    assert_eq!((t.width, t.height), (100, 50));
}

#[test]
fn extreme_ratio_keeps_at_least_one_pixel() {
    let t = make_thumbnail(&png(2000, 2, [1, 2, 3, 255]), 320).unwrap();
    assert_eq!((t.width, t.height), (320, 1));
}

#[test]
fn keeps_transparency() {
    let t = make_thumbnail(&png(400, 400, [255, 0, 0, 0]), 320).unwrap();
    assert_eq!(decoded(&t).get_pixel(160, 160).0[3], 0);
    let t = make_thumbnail(&png(400, 400, [255, 0, 0, 255]), 320).unwrap();
    assert_eq!(decoded(&t).get_pixel(160, 160).0[3], 255);
}

/// 在 JPEG 的 SOI 之后插入一个只含“方向”标签的 EXIF 段。
fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
    let mut seg = vec![0xFF, 0xE1, 0x00, 0x22];
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(&[0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]); // 大端 TIFF 头
    seg.extend_from_slice(&[0x00, 0x01]);                                     // 1 个条目
    seg.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00]);
    seg.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);                         // 无下一个 IFD
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&seg);
    out.extend_from_slice(&jpeg[2..]);
    out
}

#[test]
fn applies_exif_orientation() {
    let data = vec![200u8; 40 * 20 * 4];
    let jpeg = encode_jpeg(RgbaView { width: 40, height: 20, data: &data }, 90, [0; 3]).unwrap();
    let t = make_thumbnail(&with_exif_orientation(&jpeg, 6), 320).unwrap(); // 6 = 顺时针 90°
    assert_eq!((t.width, t.height), (20, 40));
    let t = make_thumbnail(&jpeg, 320).unwrap();
    assert_eq!((t.width, t.height), (40, 20));
}

#[test]
fn bad_input_is_an_error_not_a_panic() {
    assert!(matches!(make_thumbnail(b"", 320), Err(ImagingError::Decode(_))));
    assert!(matches!(make_thumbnail(b"not an image at all", 320), Err(ImagingError::Decode(_))));
    let mut truncated = png(64, 64, [1, 2, 3, 255]);
    truncated.truncate(40);
    assert!(matches!(make_thumbnail(&truncated, 320), Err(ImagingError::Decode(_))));
    assert!(matches!(make_thumbnail(&png(8, 8, [0; 4]), 0), Err(ImagingError::InvalidMaxEdge)));
}

#[test]
fn decode_rgba_applies_orientation() {
    let data = vec![200u8; 40 * 20 * 4];
    let jpeg = encode_jpeg(RgbaView { width: 40, height: 20, data: &data }, 90, [0; 3]).unwrap();
    let d = decode_rgba(&with_exif_orientation(&jpeg, 6), u64::MAX).unwrap();
    assert_eq!((d.width, d.height), (20, 40));
    assert_eq!(d.rgba.len(), 20 * 40 * 4);
}

#[test]
fn decode_rgba_refuses_oversized_images() {
    assert!(matches!(decode_rgba(&png(20, 20, [1, 2, 3, 255]), 100), Err(ImagingError::TooLarge)));
    let d = decode_rgba(&png(10, 10, [1, 2, 3, 255]), 100).unwrap();
    assert_eq!((d.width, d.height), (10, 10));
    assert_eq!(&d.rgba[..4], &[1, 2, 3, 255]);
}

#[test]
fn decode_rgba_of_garbage_is_an_error() {
    assert!(matches!(decode_rgba(b"not an image at all", u64::MAX), Err(ImagingError::Decode(_))));
    assert!(matches!(decode_rgba(b"", u64::MAX), Err(ImagingError::Decode(_))));
}
