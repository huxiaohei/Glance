//! 减色：把 RGBA 图量化成不超过 colors 个颜色的调色板与逐像素索引。
//! 封装在一个函数后面，日后换库只改这里。

use std::collections::HashMap;

use color_quant::NeuQuant;

use crate::encode::RgbaView;

/// NeuQuant 减色（支持透明通道）。返回（调色板 RGBA，逐像素索引）。
/// colors 夹到 2..=256；sample 是采样因子（1 最慢最准，30 最快），夹到 1..=30。
/// 调色板顺序按 NeuQuant 输出，不排序；算法无随机数，同输入同参数结果相同。
pub fn quantize(img: RgbaView, colors: u16, sample: i32) -> (Vec<[u8; 4]>, Vec<u8>) {
    let colors = usize::from(colors.clamp(2, 256));
    if let Some(exact) = exact_palette(img.data, colors) {
        return exact;
    }
    // 全透明像素统一占调色板第 0 项（NeuQuant 把 alpha 当第四维，会把透明和不透明混在一起）。
    let has_clear = img.data.chunks_exact(4).any(|px| px[3] == 0);
    let has_partial = img
        .data
        .chunks_exact(4)
        .any(|px| px[3] != 0 && px[3] != 255);
    let rest: Vec<u8> = if has_clear {
        img.data
            .chunks_exact(4)
            .filter(|px| px[3] != 0)
            .flatten()
            .copied()
            .collect()
    } else {
        img.data.to_vec()
    };
    let offset = usize::from(has_clear);
    let mut palette: Vec<[u8; 4]> = Vec::with_capacity(colors);
    if has_clear {
        palette.push([0, 0, 0, 0]);
    }
    if rest.is_empty() {
        return (palette, vec![0; img.data.len() / 4]);
    }
    let nq = NeuQuant::new(sample.clamp(1, 30), colors - offset, &rest);
    palette.extend(nq.color_map_rgba().chunks_exact(4).map(|c| {
        // 只有 0 / 255 两种 alpha 时，不透明像素必须仍然不透明。
        [c[0], c[1], c[2], if has_partial { c[3] } else { 255 }]
    }));
    let indices = img
        .data
        .chunks_exact(4)
        .map(|px| {
            if px[3] == 0 {
                0
            } else {
                (nq.index_of(px) + offset) as u8
            }
        })
        .collect();
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
}
