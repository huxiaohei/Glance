use glance_imaging::{
    EditParams, ImagingError, OutFormat, PngMode, RgbaView, SrcFormat, apply, downscale, out_dims,
    src_format_of,
};

fn gradient(w: u32, h: u32) -> Vec<u8> {
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

fn compress(q: u8, max_edge: Option<u32>, png_mode: PngMode) -> EditParams {
    EditParams::Compress {
        quality: q,
        max_edge,
        png_mode,
    }
}

fn convert(format: OutFormat, q: u8, fill: [u8; 3]) -> EditParams {
    EditParams::Convert {
        format,
        quality: q,
        fill,
    }
}

#[test]
fn compress_gif_bmp_unsupported() {
    let d = gradient(8, 8);
    for f in [SrcFormat::Gif, SrcFormat::Bmp] {
        let r = apply(view(8, 8, &d), f, None, None, &compress(80, None, PngMode::Lossy));
        assert!(matches!(r, Err(ImagingError::Unsupported)), "{f:?}");
    }
}

#[test]
fn max_edge_never_upscales() {
    let d = gradient(100, 50);
    let e = apply(
        view(100, 50, &d),
        SrcFormat::Jpeg,
        None,
        None,
        &compress(80, Some(200), PngMode::Lossy),
    )
    .unwrap();
    assert_eq!((e.width, e.height), (100, 50));
}

#[test]
fn max_edge_downscales() {
    let d = gradient(400, 200);
    for f in [SrcFormat::Jpeg, SrcFormat::Png, SrcFormat::Webp] {
        let e = apply(
            view(400, 200, &d),
            f,
            None,
            None,
            &compress(80, Some(100), PngMode::Lossless),
        )
        .unwrap();
        assert_eq!((e.width, e.height), (100, 50));
        let img = image::load_from_memory(&e.bytes).unwrap();
        assert_eq!((img.width(), img.height()), (100, 50));
    }
}

#[test]
fn convert_to_jpeg_fills_background() {
    let d = vec![0u8; 2 * 2 * 4];
    let e = apply(
        view(2, 2, &d),
        SrcFormat::Png,
        None,
        None,
        &convert(OutFormat::Jpeg, 95, [0, 0, 255]),
    )
    .unwrap();
    assert_eq!(e.format, OutFormat::Jpeg);
    let px = image::load_from_memory(&e.bytes)
        .unwrap()
        .to_rgb8()
        .get_pixel(0, 0)
        .0;
    assert!(px[0] < 20 && px[1] < 20 && px[2] > 235, "{px:?}");
}

#[test]
fn convert_keeps_size() {
    let d = gradient(37, 21);
    for f in [OutFormat::Png, OutFormat::Jpeg, OutFormat::Webp] {
        let e = apply(
            view(37, 21, &d),
            SrcFormat::Gif,
            None,
            None,
            &convert(f, 85, [255; 3]),
        )
        .unwrap();
        assert_eq!((e.width, e.height, e.format), (37, 21, f));
        let img = image::load_from_memory(&e.bytes).unwrap();
        assert_eq!((img.width(), img.height()), (37, 21));
    }
}

#[test]
fn quality_out_of_range_rejected() {
    let d = gradient(8, 8);
    for q in [0u8, 101] {
        let r = apply(
            view(8, 8, &d),
            SrcFormat::Jpeg,
            None,
            None,
            &compress(q, None, PngMode::Lossy),
        );
        assert!(matches!(r, Err(ImagingError::InvalidQuality(_))));
        let r = apply(
            view(8, 8, &d),
            SrcFormat::Png,
            None,
            None,
            &convert(OutFormat::Png, q, [255; 3]),
        );
        assert!(matches!(r, Err(ImagingError::InvalidQuality(_))));
    }
}

#[test]
fn apply_is_deterministic() {
    let d = gradient(96, 64);
    let mut cases: Vec<(SrcFormat, EditParams)> = Vec::new();
    for f in [SrcFormat::Png, SrcFormat::Jpeg, SrcFormat::Webp] {
        for mode in [PngMode::Lossy, PngMode::Lossless] {
            cases.push((f, compress(70, Some(48), mode)));
        }
    }
    for f in [OutFormat::Png, OutFormat::Jpeg, OutFormat::Webp] {
        cases.push((SrcFormat::Bmp, convert(f, 85, [255; 3])));
    }
    for (src, p) in cases {
        let a = apply(view(96, 64, &d), src, None, None, &p).unwrap();
        let b = apply(view(96, 64, &d), src, None, None, &p).unwrap();
        assert_eq!(a.bytes, b.bytes, "{src:?} {p:?}");
    }
}

#[test]
fn src_format_sniffs_headers() {
    let d = gradient(4, 4);
    let v = || view(4, 4, &d);
    let png = glance_imaging::encode_png_lossless(v(), None).unwrap();
    let jpg = glance_imaging::encode_jpeg(v(), 80, [255; 3], None, None).unwrap();
    let webp = glance_imaging::encode_webp(v(), 80, None, None).unwrap();
    assert_eq!(src_format_of(&png), Some(SrcFormat::Png));
    assert_eq!(src_format_of(&jpg), Some(SrcFormat::Jpeg));
    assert_eq!(src_format_of(&webp), Some(SrcFormat::Webp));
    assert_eq!(src_format_of(b"GIF89a\x01\x00"), Some(SrcFormat::Gif));
    assert_eq!(src_format_of(b"GIF87a\x01\x00"), Some(SrcFormat::Gif));
    assert_eq!(src_format_of(b"BM\x00\x00\x00\x00"), Some(SrcFormat::Bmp));
    assert_eq!(src_format_of(b"hello world, not an image"), None);
    assert_eq!(src_format_of(b""), None);
}

#[test]
fn serde_shape_is_stable() {
    let c = compress(80, None, PngMode::Lossy);
    assert_eq!(
        serde_json::to_string(&c).unwrap(),
        r#"{"op":"compress","quality":80,"maxEdge":null,"pngMode":"lossy"}"#
    );
    let v = convert(OutFormat::Jpeg, 85, [255, 255, 255]);
    assert_eq!(
        serde_json::to_string(&v).unwrap(),
        r#"{"op":"convert","format":"jpeg","quality":85,"fill":[255,255,255]}"#
    );
    let back: EditParams = serde_json::from_str(
        r#"{"op":"compress","quality":50,"maxEdge":2048,"pngMode":"lossless"}"#,
    )
    .unwrap();
    assert_eq!(back, compress(50, Some(2048), PngMode::Lossless));
    assert_eq!(
        serde_json::to_string(&SrcFormat::Webp).unwrap(),
        r#""webp""#
    );
}

#[test]
fn downscale_fits_long_edge() {
    let d = gradient(3000, 1000);
    let r = downscale(view(3000, 1000, &d), 2048).unwrap();
    assert_eq!((r.width, r.height), (2048, 683));
    assert_eq!(r.rgba.len(), 2048 * 683 * 4);
    let d = gradient(1000, 3000);
    let r = downscale(view(1000, 3000, &d), 1024).unwrap();
    assert_eq!((r.width, r.height), (341, 1024));
}

#[test]
fn downscale_keeps_small_images() {
    let d = gradient(100, 50);
    let r = downscale(view(100, 50, &d), 2048).unwrap();
    assert_eq!((r.width, r.height), (100, 50));
    assert_eq!(r.rgba, d);
    assert!(matches!(
        downscale(view(100, 50, &d), 0),
        Err(ImagingError::InvalidMaxEdge)
    ));
}

#[test]
fn downscale_keeps_transparent_edges_clean() {
    // 左半全透明的红、右半不透明的白：预乘缩放后透明区不应把红色带进白边。
    let (w, h) = (64u32, 16u32);
    let d: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            if i % w < w / 2 {
                [255, 0, 0, 0]
            } else {
                [255, 255, 255, 255]
            }
        })
        .collect();
    let r = downscale(view(w, h, &d), 32).unwrap();
    for p in r.rgba.chunks_exact(4).filter(|p| p[3] > 0) {
        assert!(p[1] > 200 && p[2] > 200, "{p:?}");
    }
}

#[test]
fn out_dims_matches_apply() {
    let d = gradient(300, 100);
    for p in [
        compress(80, None, PngMode::Lossy),
        compress(80, Some(64), PngMode::Lossless),
        compress(80, Some(1000), PngMode::Lossy),
        convert(OutFormat::Webp, 80, [255; 3]),
    ] {
        let e = apply(view(300, 100, &d), SrcFormat::Png, None, None, &p).unwrap();
        assert_eq!(out_dims(300, 100, &p), (e.width, e.height), "{p:?}");
    }
}

fn crop(rect: (u32, u32, u32, u32), turns: u8) -> EditParams {
    EditParams::Crop {
        rect: glance_imaging::CropRect {
            x: rect.0,
            y: rect.1,
            w: rect.2,
            h: rect.3,
        },
        quarter_turns: turns,
        flip_h: false,
        flip_v: true,
    }
}

#[test]
fn crop_output_format_follows_source() {
    let d = gradient(8, 6);
    for (src, out) in [
        (SrcFormat::Jpeg, OutFormat::Jpeg),
        (SrcFormat::Png, OutFormat::Png),
        (SrcFormat::Webp, OutFormat::Webp),
        (SrcFormat::Gif, OutFormat::Png),
        (SrcFormat::Bmp, OutFormat::Png),
    ] {
        let e = apply(view(8, 6, &d), src, None, None, &crop((1, 1, 3, 2), 0)).unwrap();
        assert_eq!(e.format, out);
        assert_eq!((e.width, e.height), (3, 2));
        assert_eq!(out_dims(8, 6, &crop((1, 1, 3, 2), 0)), (3, 2));
    }
}

#[test]
fn crop_after_rotation_uses_rotated_frame() {
    let d = gradient(8, 6);
    // 转 1 圈后画面是 6×8，可取 6×8 的整幅
    let e = apply(view(8, 6, &d), SrcFormat::Png, None, None, &crop((0, 0, 6, 8), 1)).unwrap();
    assert_eq!((e.width, e.height), (6, 8));
    assert!(matches!(
        apply(view(8, 6, &d), SrcFormat::Png, None, None, &crop((0, 0, 8, 6), 1)),
        Err(ImagingError::InvalidParams(_))
    ));
}

#[test]
fn crop_rejects_bad_turns() {
    let d = gradient(8, 6);
    assert!(matches!(
        apply(view(8, 6, &d), SrcFormat::Png, None, None, &crop((0, 0, 2, 2), 4)),
        Err(ImagingError::InvalidParams(_))
    ));
}

#[test]
fn crop_is_deterministic() {
    let d = gradient(8, 6);
    for src in [SrcFormat::Jpeg, SrcFormat::Png, SrcFormat::Webp] {
        let p = crop((1, 0, 5, 4), 1);
        let a = apply(view(8, 6, &d), src, None, None, &p).unwrap();
        let b = apply(view(8, 6, &d), src, None, None, &p).unwrap();
        assert_eq!(a.bytes, b.bytes);
    }
}

#[test]
fn crop_keeps_png_icc() {
    let d = gradient(8, 6);
    let icc: Vec<u8> = (0..200u32).map(|i| (i * 7) as u8).collect();
    let e = apply(
        view(8, 6, &d),
        SrcFormat::Png,
        Some(&icc),
        None,
        &crop((0, 0, 4, 4), 0),
    )
    .unwrap();
    let back = glance_imaging::decode_rgba_icc(&e.bytes, 1 << 20).unwrap();
    assert_eq!(back.icc.as_deref(), Some(icc.as_slice()));
}

#[test]
fn crop_without_orientation_takes_pixels_straight_from_source() {
    let d = gradient(8, 6);
    let p = EditParams::Crop {
        rect: glance_imaging::CropRect {
            x: 2,
            y: 1,
            w: 4,
            h: 3,
        },
        quarter_turns: 0,
        flip_h: false,
        flip_v: false,
    };
    let e = apply(view(8, 6, &d), SrcFormat::Png, None, None, &p).unwrap();
    assert_eq!((e.width, e.height), (4, 3));
    let back = glance_imaging::decode_rgba_icc(&e.bytes, 1 << 20).unwrap();
    let exp: Vec<u8> = (1..4u8)
        .flat_map(|y| (2..6u8).flat_map(move |x| [x, y, 128, 255]))
        .collect();
    assert_eq!(back.decoded.rgba, exp);
}

#[test]
fn crop_serde_round_trip() {
    let json = r#"{"op":"crop","rect":{"x":0,"y":0,"w":10,"h":10},"quarterTurns":1,"flipH":false,"flipV":true}"#;
    let p: EditParams = serde_json::from_str(json).unwrap();
    assert_eq!(p, crop((0, 0, 10, 10), 1));
    assert_eq!(serde_json::to_string(&p).unwrap(), json);
}
