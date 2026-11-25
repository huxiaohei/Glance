//! 减色：把 RGBA 图量化成不超过 colors 个颜色的调色板与逐像素索引。
//! 封装在一个函数后面，日后换库只改这里。

use std::collections::HashMap;

use color_quant::NeuQuant;

use crate::encode::RgbaView;

/// 减色，支持透明通道。返回（调色板 RGBA，逐像素索引）。
/// colors 夹到 8..=256；sample 是采样因子（1 最慢最准，30 最快），夹到 1..=30。
/// 不同颜色数不超过 colors 时调色板就是原色（精确）。否则按 alpha 分组：
/// 全透明像素占第 0 项；半透明像素的 alpha 吸附到 6 个等级（误差 ≤ 24）；
/// 不透明像素 alpha 保持 255；每组按像素数分到若干调色板位，组内用 NeuQuant 只量 RGB。
/// 算法无随机数，同输入同参数结果相同。
pub fn quantize(img: RgbaView, colors: u16, sample: i32) -> (Vec<[u8; 4]>, Vec<u8>) {
    let colors = usize::from(colors.clamp(8, 256));
    if let Some(exact) = exact_palette(img.data, colors) {
        return exact;
    }
    let npx = img.data.len() / 4;
    // 组号：0 = 全透明，1..=6 = 半透明，7 = 不透明。
    const SEMI_ALPHA: [u8; 6] = [24, 72, 120, 168, 216, 247];
    let group_of = |a: u8| -> usize {
        match a {
            0 => 0,
            255 => 7,
            1..=47 => 1,
            240..=254 => 6,
            a => usize::from(a) / 48 + 1,
        }
    };
    let group_alpha = |g: usize| -> u8 {
        match g {
            0 => 0,
            7 => 255,
            g => SEMI_ALPHA[g - 1],
        }
    };
    let mut members: [Vec<usize>; 8] = Default::default();
    for (i, px) in img.data.chunks_exact(4).enumerate() {
        members[group_of(px[3])].push(i);
    }
    let present: Vec<usize> = (0..8).filter(|&g| !members[g].is_empty()).collect();
    // 分配调色板位：每组至少 1，其余按像素数比例，零头给最大的组；全透明组固定 1 位。
    let mut budget = [0usize; 8];
    for &g in &present {
        budget[g] = 1;
    }
    let spare = colors - present.len();
    let weight_total: usize = present
        .iter()
        .filter(|&&g| g != 0)
        .map(|&g| members[g].len())
        .sum();
    for &g in present.iter().filter(|&&g| g != 0) {
        budget[g] += spare * members[g].len() / weight_total;
    }
    // 取整留下的零头给像素最多的组（至少有一个非全透明组：否则 exact_palette 已返回）。
    let left = colors - budget.iter().sum::<usize>();
    if let Some(&big) = present
        .iter()
        .filter(|&&g| g != 0)
        .max_by_key(|&&g| members[g].len())
    {
        budget[big] += left;
    }

    let mut palette: Vec<[u8; 4]> = Vec::with_capacity(colors);
    let mut indices = vec![0u8; npx];
    for &g in &present {
        let base = palette.len();
        let alpha = group_alpha(g);
        let ids = &members[g];
        if g == 0 {
            palette.push([0, 0, 0, 0]);
            continue; // 全透明组排第一，索引默认就是 0
        }
        let rgb: Vec<u8> = ids
            .iter()
            .flat_map(|&i| {
                [
                    img.data[i * 4],
                    img.data[i * 4 + 1],
                    img.data[i * 4 + 2],
                    255,
                ]
            })
            .collect();
        let b = budget[g];
        if b < 2 {
            // 只有 1 位：取平均色。
            let n = ids.len() as u64;
            let mut sum = [0u64; 3];
            for px in rgb.chunks_exact(4) {
                for c in 0..3 {
                    sum[c] += u64::from(px[c]);
                }
            }
            palette.push([
                (sum[0] / n) as u8,
                (sum[1] / n) as u8,
                (sum[2] / n) as u8,
                alpha,
            ]);
            for &i in ids {
                indices[i] = base as u8;
            }
            continue;
        }
        // 像素太少时 NeuQuant 一个样本都学不到，采样因子降到 1。
        let sample = if ids.len() < b * 64 {
            1
        } else {
            sample.clamp(1, 30)
        };
        let nq = NeuQuant::new(sample, b, &rgb);
        palette.extend(
            nq.color_map_rgba()
                .chunks_exact(4)
                .map(|c| [c[0], c[1], c[2], alpha]),
        );
        for (k, &i) in ids.iter().enumerate() {
            indices[i] = (base + nq.index_of(&rgb[k * 4..k * 4 + 4])) as u8;
        }
    }
    (palette, indices)
}

/// 图里不同的颜色不超过 colors 个时直接用原色当调色板，一个都不失真
/// （NeuQuant 的采样会漏掉稀有颜色，比如一列半透明边缘）。超过则返回 None。
fn exact_palette(data: &[u8], colors: usize) -> Option<(Vec<[u8; 4]>, Vec<u8>)> {
    let mut map: HashMap<[u8; 4], u8> = HashMap::new();
    let mut palette = Vec::new();
    let mut indices = Vec::with_capacity(data.len() / 4);
    for px in data.chunks_exact(4) {
        let key = [px[0], px[1], px[2], px[3]];
        let idx = match map.get(&key) {
            Some(&i) => i,
            None => {
                if palette.len() == colors {
                    return None;
                }
                let i = palette.len() as u8;
                map.insert(key, i);
                palette.push(key);
                i
            }
        };
        indices.push(idx);
    }
    Some((palette, indices))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_palette_le_colors() {
        let (w, h) = (64u32, 64u32);
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, ((x + y) * 2) as u8, 255]);
            }
        }
        let img = RgbaView {
            width: w,
            height: h,
            data: &data,
        };
        let (palette, indices) = quantize(img, 32, 10);
        assert!(palette.len() <= 32 && !palette.is_empty());
        assert_eq!(indices.len(), (w * h) as usize);
        assert!(indices.iter().all(|&i| (i as usize) < palette.len()));
    }

    fn noisy(n: usize) -> Vec<u8> {
        let mut seed = 99u32;
        let mut d = Vec::new();
        for _ in 0..n {
            for _ in 0..3 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                d.push((seed >> 24) as u8);
            }
            d.push(255);
        }
        d
    }

    #[test]
    fn tiny_image_with_more_colors_than_palette_does_not_panic() {
        let d = noisy(20);
        let (palette, indices) = quantize(
            RgbaView {
                width: 20,
                height: 1,
                data: &d,
            },
            18,
            30,
        );
        assert!(palette.len() <= 18);
        assert_eq!(indices.len(), 20);
        assert!(indices.iter().all(|&i| (i as usize) < palette.len()));
    }

    #[test]
    fn minimal_colors_with_transparency_is_safe() {
        let mut d = noisy(100);
        for px in d.chunks_exact_mut(4).take(30) {
            px[3] = 0;
        }
        for px in d.chunks_exact_mut(4).skip(30).take(30) {
            px[3] = 100;
        }
        for colors in [1u16, 2, 3, 8, 18] {
            let (palette, indices) = quantize(
                RgbaView {
                    width: 100,
                    height: 1,
                    data: &d,
                },
                colors,
                30,
            );
            assert!(palette.len() <= usize::from(colors.max(8)));
            assert!(indices.iter().all(|&i| (i as usize) < palette.len()));
            for (px, &i) in d.chunks_exact(4).zip(&indices) {
                let a = palette[i as usize][3];
                assert!(a.abs_diff(px[3]) <= 24, "alpha {} -> {}", px[3], a);
            }
        }
    }
}
