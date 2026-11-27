//! 去背景：按 alpha 阈值，或按选定底色（容差、软边、仅边缘连通）把背景变透明；另有取色。

use serde::{Deserialize, Serialize};

use crate::encode::{RgbaView, validate};
use crate::error::ImagingError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RemoveBg {
    /// 把 alpha 低于（`below`）或高于阈值的像素变全透明。
    #[serde(rename_all = "camelCase")]
    Alpha { threshold: u8, below: bool },
    /// 与底色的距离百分比 ≤ tolerance 的变透明，tolerance 之上 softness 宽的过渡带线性渐变。
    #[serde(rename_all = "camelCase")]
    Color {
        color: [u8; 3],
        tolerance: u8,
        softness: u8,
        edge_connected: bool,
    },
}

/// 与底色的距离百分比：RGB 欧氏距离 / (√3·255) × 100。
fn dist_pct(px: &[u8], b: [u8; 3]) -> f32 {
    let d = |i: usize| f32::from(px[i]) - f32::from(b[i]);
    (d(0) * d(0) + d(1) * d(1) + d(2) * d(2)).sqrt() / (3f32.sqrt() * 255.0) * 100.0
}

/// 不透明系数 f：0 全透明，1 不动，介于其间为过渡带。
/// 已全透明的像素一律算受影响（f = 0）：它们的隐藏 RGB 无意义，透明边要能把“仅边缘连通”接到真正的底色上。
fn factor(px: &[u8], b: [u8; 3], tol: u8, soft: u8) -> f32 {
    if px[3] == 0 {
        return 0.0;
    }
    let d = dist_pct(px, b);
    let t = f32::from(tol);
    if soft == 0 {
        if d <= t { 0.0 } else { 1.0 }
    } else {
        ((d - t) / f32::from(soft)).clamp(0.0, 1.0)
    }
}

/// 写入系数 f：新 alpha = round(原 alpha × f)；0 < f < 1 时按底色去色溢。
fn apply_factor(px: &mut [u8], b: [u8; 3], f: f32) {
    if f <= 0.0 {
        px[3] = 0;
        return;
    }
    if f < 1.0 {
        for i in 0..3 {
            let c = (f32::from(px[i]) - (1.0 - f) * f32::from(b[i])) / f;
            px[i] = c.round().clamp(0.0, 255.0) as u8;
        }
    }
    px[3] = (f32::from(px[3]) * f).round() as u8;
}

/// 返回同尺寸 RGBA。
pub fn remove_bg(src: RgbaView, p: &RemoveBg) -> Result<Vec<u8>, ImagingError> {
    validate(&src)?;
    let mut out = src.data.to_vec();
    match *p {
        RemoveBg::Alpha { threshold, below } => {
            for px in out.chunks_exact_mut(4) {
                let hit = if below {
                    px[3] < threshold
                } else {
                    px[3] > threshold
                };
                if hit {
                    px[3] = 0;
                }
            }
        }
        RemoveBg::Color {
            color,
            tolerance,
            softness,
            edge_connected,
        } => {
            if tolerance > 100 || softness > 100 {
                return Err(ImagingError::InvalidParams(
                    "容差和柔化必须在 0 到 100 之间",
                ));
            }
            if !edge_connected {
                for px in out.chunks_exact_mut(4) {
                    let f = factor(px, color, tolerance, softness);
                    if f < 1.0 {
                        apply_factor(px, color, f);
                    }
                }
            } else {
                let reached = flood_from_border(&out, src.width, src.height, |px| {
                    factor(px, color, tolerance, softness) < 1.0
                });
                for (i, px) in out.chunks_exact_mut(4).enumerate() {
                    if reached[i] {
                        let f = factor(px, color, tolerance, softness);
                        apply_factor(px, color, f);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// 从四边上所有“受影响”像素出发，4 邻域、只经过受影响像素，返回到达的像素标记。
/// 显式栈，不递归。
fn flood_from_border(data: &[u8], w: u32, h: u32, affected: impl Fn(&[u8]) -> bool) -> Vec<bool> {
    let (w, h) = (w as usize, h as usize);
    let mut seen = vec![false; w * h];
    let mut stack: Vec<u32> = Vec::new();
    let hit = |i: usize| affected(&data[i * 4..i * 4 + 4]);
    let mut seed = |i: usize, seen: &mut Vec<bool>| {
        if !seen[i] && hit(i) {
            seen[i] = true;
            stack.push(i as u32);
        }
    };
    for x in 0..w {
        seed(x, &mut seen);
        seed((h - 1) * w + x, &mut seen);
    }
    for y in 0..h {
        seed(y * w, &mut seen);
        seed(y * w + w - 1, &mut seen);
    }
    while let Some(i) = stack.pop() {
        let i = i as usize;
        let (x, y) = (i % w, i / w);
        let mut visit = |j: usize| {
            if !seen[j] && affected(&data[j * 4..j * 4 + 4]) {
                seen[j] = true;
                stack.push(j as u32);
            }
        };
        if x > 0 {
            visit(i - 1);
        }
        if x + 1 < w {
            visit(i + 1);
        }
        if y > 0 {
            visit(i - w);
        }
        if y + 1 < h {
            visit(i + w);
        }
    }
    seen
}

/// 取 (x, y) 处像素的 RGB；越界返回 `InvalidParams`。
pub fn pick(src: RgbaView, x: u32, y: u32) -> Result<[u8; 3], ImagingError> {
    validate(&src)?;
    if x >= src.width || y >= src.height {
        return Err(ImagingError::InvalidParams("取色位置超出图片"));
    }
    let i = (y as usize * src.width as usize + x as usize) * 4;
    Ok([src.data[i], src.data[i + 1], src.data[i + 2]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{EditParams, OutFormat, SrcFormat, apply};
    use crate::encode::{encode_png_fast, encode_png_lossless};

    fn view(w: u32, h: u32, d: &[u8]) -> RgbaView<'_> {
        RgbaView {
            width: w,
            height: h,
            data: d,
        }
    }

    fn color(c: [u8; 3], tol: u8, soft: u8, edge: bool) -> RemoveBg {
        RemoveBg::Color {
            color: c,
            tolerance: tol,
            softness: soft,
            edge_connected: edge,
        }
    }

    fn decode(png: &[u8]) -> (u32, u32, Vec<u8>) {
        let d = image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8();
        (d.width(), d.height(), d.into_raw())
    }

    #[test]
    fn alpha_below_threshold() {
        let d = [10, 20, 30, 15, 40, 50, 60, 16];
        let out = remove_bg(
            view(2, 1, &d),
            &RemoveBg::Alpha {
                threshold: 16,
                below: true,
            },
        )
        .unwrap();
        assert_eq!(out, [10, 20, 30, 0, 40, 50, 60, 16]);
    }

    #[test]
    fn alpha_above_threshold() {
        let d = [1, 2, 3, 201, 4, 5, 6, 200];
        let out = remove_bg(
            view(2, 1, &d),
            &RemoveBg::Alpha {
                threshold: 200,
                below: false,
            },
        )
        .unwrap();
        assert_eq!(out, [1, 2, 3, 0, 4, 5, 6, 200]);
    }

    #[test]
    fn color_hard_edge() {
        let d = [255, 255, 255, 255, 204, 204, 204, 255];
        let out = remove_bg(view(2, 1, &d), &color([255; 3], 10, 0, false)).unwrap();
        assert_eq!(out[3], 0);
        assert_eq!(&out[4..8], &d[4..8]);
    }

    #[test]
    fn color_soft_band_is_linear() {
        // 底色白，灰度 g 的 d = (255 - g) / 255 * 100；t = 10, s = 20
        let d = [230, 230, 230, 255, 204, 204, 204, 255, 178, 178, 178, 255];
        let out = remove_bg(view(3, 1, &d), &color([255; 3], 10, 20, false)).unwrap();
        assert_eq!(out[3], 0);
        assert!((i32::from(out[7]) - 128).abs() <= 1, "{}", out[7]);
        assert_eq!(out[11], 255);
        assert_eq!(&out[8..11], &d[8..11]);
    }

    #[test]
    fn color_decontaminates_partial_pixels() {
        let b = [255u8; 3];
        let f = [1u8, 1, 201];
        let p: Vec<u8> = (0..3)
            .map(|i| ((u16::from(f[i]) + u16::from(b[i])) / 2) as u8)
            .collect();
        let d = [p[0], p[1], p[2], 255];
        let out = remove_bg(view(1, 1, &d), &color(b, 1, 80, false)).unwrap();
        let alpha = f32::from(out[3]) / 255.0;
        assert!((alpha - 0.5).abs() < 0.02, "alpha {alpha}");
        for i in 0..3 {
            assert!(
                (i32::from(out[i]) - i32::from(f[i])).abs() <= 2,
                "ch {i}: {out:?}"
            );
            let over = f32::from(out[i]) * alpha + f32::from(b[i]) * (1.0 - alpha);
            assert!((over - f32::from(p[i])).abs() <= 2.0, "ch {i} over {over}");
        }
    }

    #[test]
    fn color_multiplies_original_alpha() {
        // d = 20, t = 10, s = 20 -> f = 0.5
        let d = [204, 204, 204, 100];
        let out = remove_bg(view(1, 1, &d), &color([255; 3], 10, 20, false)).unwrap();
        assert!((i32::from(out[3]) - 50).abs() <= 1, "{}", out[3]);
    }

    fn framed() -> Vec<u8> {
        // 5x5 白底，中间 3x3 红框，框内中心白点
        let mut d = Vec::new();
        for y in 0..5 {
            for x in 0..5 {
                let ring = (1..=3).contains(&x) && (1..=3).contains(&y) && !(x == 2 && y == 2);
                d.extend_from_slice(if ring { &[255, 0, 0, 255] } else { &[255; 4] });
            }
        }
        d
    }

    #[test]
    fn edge_connected_keeps_enclosed_background() {
        let d = framed();
        let on = remove_bg(view(5, 5, &d), &color([255; 3], 5, 0, true)).unwrap();
        assert_eq!(&on[(2 * 5 + 2) * 4..(2 * 5 + 2) * 4 + 4], &[255; 4]);
        assert_eq!(on[3], 0);
        let off = remove_bg(view(5, 5, &d), &color([255; 3], 5, 0, false)).unwrap();
        assert_eq!(off[(2 * 5 + 2) * 4 + 3], 0);
        // 红框两种情况都不动
        assert_eq!(&on[(5 + 1) * 4..(5 + 1) * 4 + 4], &[255, 0, 0, 255]);
    }

    /// 7x7：最外一圈全透明（隐藏色黑，离白底很远），第二圈不透明白底，中间 3x3 红色主体。
    fn transparent_border() -> Vec<u8> {
        let mut d = Vec::new();
        for y in 0..7i32 {
            for x in 0..7i32 {
                let ring = x.min(y).min(6 - x).min(6 - y);
                d.extend_from_slice(match ring {
                    0 => &[0, 0, 0, 0],
                    1 => &[255; 4],
                    _ => &[255, 0, 0, 255],
                });
            }
        }
        d
    }

    #[test]
    fn transparent_border_connects_flood_to_background() {
        let d = transparent_border();
        let out = remove_bg(view(7, 7, &d), &color([255; 3], 5, 0, true)).unwrap();
        let px = |x: usize, y: usize| &out[(y * 7 + x) * 4..(y * 7 + x) * 4 + 4];
        // 透明边保持全透明
        assert_eq!(px(0, 0)[3], 0);
        assert_eq!(px(3, 0)[3], 0);
        // 白底圈被去掉
        for (x, y) in [(1, 1), (3, 1), (1, 3), (5, 5)] {
            assert_eq!(px(x, y)[3], 0, "({x}, {y})");
        }
        // 主体不动
        for (x, y) in [(2, 2), (3, 3), (4, 4)] {
            assert_eq!(px(x, y), &[255, 0, 0, 255], "({x}, {y})");
        }
    }

    #[test]
    fn transparent_pixels_stay_transparent_without_edge_connection() {
        let d = [0, 0, 0, 0, 255, 0, 0, 255];
        let out = remove_bg(view(2, 1, &d), &color([255; 3], 5, 20, false)).unwrap();
        assert_eq!(out[3], 0);
        assert_eq!(&out[4..8], &d[4..8]);
    }

    #[test]
    fn single_pixel_and_all_background() {
        let d = [255u8; 4];
        let out = remove_bg(view(1, 1, &d), &color([255; 3], 5, 5, true)).unwrap();
        assert_eq!(out[3], 0);
        let big = vec![255u8; 8 * 8 * 4];
        let enc = apply(
            view(8, 8, &big),
            SrcFormat::Png,
            false,
            None,
            None,
            &EditParams::RemoveBg(color([255; 3], 5, 0, true)),
        )
        .unwrap();
        let (_, _, px) = decode(&enc.bytes);
        assert!(px.chunks_exact(4).all(|p| p[3] == 0));
    }

    #[test]
    fn rejects_out_of_range_params() {
        let d = [0u8; 4];
        for p in [color([0; 3], 101, 0, false), color([0; 3], 0, 101, false)] {
            assert!(matches!(
                remove_bg(view(1, 1, &d), &p),
                Err(ImagingError::InvalidParams(_))
            ));
        }
    }

    #[test]
    fn pick_returns_rgb_and_checks_bounds() {
        let d = [1, 2, 3, 255, 4, 5, 6, 255];
        assert_eq!(pick(view(2, 1, &d), 1, 0).unwrap(), [4, 5, 6]);
        assert!(matches!(
            pick(view(2, 1, &d), 2, 0),
            Err(ImagingError::InvalidParams(_))
        ));
        assert!(matches!(
            pick(view(2, 1, &d), 0, 1),
            Err(ImagingError::InvalidParams(_))
        ));
    }

    fn noisy(w: u32, h: u32) -> Vec<u8> {
        (0..w * h * 4)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect()
    }

    #[test]
    fn fast_png_roundtrips() {
        let d = noisy(7, 5);
        let png = encode_png_fast(view(7, 5, &d)).unwrap();
        let (w, h, px) = decode(&png);
        assert_eq!((w, h), (7, 5));
        assert_eq!(px, d);
    }

    #[test]
    fn apply_matches_remove_bg_and_is_deterministic() {
        let d = framed();
        let p = color([255; 3], 5, 10, true);
        let expect = remove_bg(view(5, 5, &d), &p).unwrap();
        let params = EditParams::RemoveBg(p);
        let a = apply(view(5, 5, &d), SrcFormat::Jpeg, false, None, None, &params).unwrap();
        let b = apply(view(5, 5, &d), SrcFormat::Jpeg, false, None, None, &params).unwrap();
        assert_eq!(a.format, OutFormat::Png);
        assert_eq!((a.width, a.height), (5, 5));
        assert_eq!(decode(&a.bytes).2, expect);
        assert_eq!(a.bytes, b.bytes);
    }

    #[test]
    fn json_is_flat() {
        let a = EditParams::RemoveBg(RemoveBg::Alpha {
            threshold: 16,
            below: true,
        });
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            r#"{"op":"removeBg","mode":"alpha","threshold":16,"below":true}"#
        );
        let c: EditParams = serde_json::from_str(
            r#"{"op":"removeBg","mode":"color","color":[255,255,255],"tolerance":10,"softness":10,"edgeConnected":true}"#,
        )
        .unwrap();
        assert_eq!(c, EditParams::RemoveBg(color([255; 3], 10, 10, true)));
    }

    #[test]
    #[ignore]
    fn bench_remove_bg() {
        use std::time::Instant;
        fn synth(w: u32, h: u32) -> Vec<u8> {
            let (cx, cy, r) = (w as f32 / 2.0, h as f32 / 2.0, h as f32 / 3.0);
            let mut d = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h {
                for x in 0..w {
                    let (dx, dy) = (x as f32 - cx, y as f32 - cy);
                    if dx * dx + dy * dy < r * r {
                        d.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 120, 255]);
                    } else {
                        d.extend_from_slice(&[255; 4]);
                    }
                }
            }
            d
        }
        let p = color([255; 3], 10, 10, true);
        for (w, h) in [(2048, 1536), (6000, 4000)] {
            let d = synth(w, h);
            let t = Instant::now();
            let out = remove_bg(view(w, h, &d), &p).unwrap();
            println!("{w}x{h} remove_bg: {:?}", t.elapsed());
            if w == 6000 {
                let t = Instant::now();
                let png = encode_png_lossless(view(w, h, &out), None).unwrap();
                println!(
                    "{w}x{h} encode_png_lossless: {:?} ({} bytes)",
                    t.elapsed(),
                    png.len()
                );
            }
        }
        let d = synth(1024, 683);
        let t = Instant::now();
        let png = encode_png_fast(view(1024, 683, &d)).unwrap();
        println!(
            "1024x683 encode_png_fast: {:?} ({} bytes)",
            t.elapsed(),
            png.len()
        );
    }
}
