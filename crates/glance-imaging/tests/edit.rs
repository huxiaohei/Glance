use glance_imaging::{
    EditParams, ImagingError, OutFormat, PngMode, RgbaView, SrcFormat, apply, src_format_of,
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
        let r = apply(view(8, 8, &d), f, None, &compress(80, None, PngMode::Lossy));
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
            &compress(q, None, PngMode::Lossy),
        );
        assert!(matches!(r, Err(ImagingError::InvalidQuality(_))));
        let r = apply(
            view(8, 8, &d),
            SrcFormat::Png,
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
        let a = apply(view(96, 64, &d), src, None, &p).unwrap();
        let b = apply(view(96, 64, &d), src, None, &p).unwrap();
        assert_eq!(a.bytes, b.bytes, "{src:?} {p:?}");
    }
}

#[test]
fn src_format_sniffs_headers() {
    let d = gradient(4, 4);
    let v = || view(4, 4, &d);
    let png = glance_imaging::encode_png_lossless(v(), None).unwrap();
    let jpg = glance_imaging::encode_jpeg(v(), 80, [255; 3], None).unwrap();
    let webp = glance_imaging::encode_webp(v(), 80).unwrap();
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
