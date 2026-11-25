use std::time::Instant;

use glance_imaging::{EditParams, OutFormat, PngMode, RgbaView, SrcFormat, apply};

fn synthetic(w: u32, h: u32) -> Vec<u8> {
    let mut s: u32 = 12345;
    (0..w * h)
        .flat_map(|i| {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            let n = (s >> 24) as u8 / 8;
            let (x, y) = (i % w, i / w);
            let a = if x < w / 8 { 128 } else { 255 };
            [
                ((x * 255 / w) as u8).saturating_add(n),
                ((y * 255 / h) as u8).saturating_add(n),
                (((x + y) / 8) % 256) as u8,
                a,
            ]
        })
        .collect()
}

#[test]
#[ignore]
fn bench_apply() {
    let (w, h) = (2048, 1536);
    let d = synthetic(w, h);
    let mut cases: Vec<(String, SrcFormat, EditParams)> = Vec::new();
    for (name, f) in [("jpeg", SrcFormat::Jpeg), ("webp", SrcFormat::Webp)] {
        for q in [60u8, 80, 95] {
            cases.push((
                format!("compress {name} q{q}"),
                f,
                EditParams::Compress {
                    quality: q,
                    max_edge: None,
                    png_mode: PngMode::Lossy,
                },
            ));
        }
    }
    for mode in [PngMode::Lossy, PngMode::Lossless] {
        for q in [60u8, 80] {
            cases.push((
                format!("compress png {mode:?} q{q}"),
                SrcFormat::Png,
                EditParams::Compress {
                    quality: q,
                    max_edge: None,
                    png_mode: mode,
                },
            ));
        }
    }
    cases.push((
        "compress jpeg q80 maxEdge1024".into(),
        SrcFormat::Jpeg,
        EditParams::Compress {
            quality: 80,
            max_edge: Some(1024),
            png_mode: PngMode::Lossy,
        },
    ));
    for f in [OutFormat::Png, OutFormat::Jpeg, OutFormat::Webp] {
        cases.push((
            format!("convert {f:?} q85"),
            SrcFormat::Png,
            EditParams::Convert {
                format: f,
                quality: 85,
                fill: [255; 3],
            },
        ));
    }
    for (name, src, p) in cases {
        let t = Instant::now();
        let e = apply(
            RgbaView {
                width: w,
                height: h,
                data: &d,
            },
            src,
            None,
            &p,
        )
        .unwrap();
        println!(
            "{name:<34} {:>7.1} ms  {:>9} bytes  {}x{}",
            t.elapsed().as_secs_f64() * 1000.0,
            e.bytes.len(),
            e.width,
            e.height
        );
    }
}
