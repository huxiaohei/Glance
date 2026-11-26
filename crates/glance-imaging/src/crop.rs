//! 裁剪：先按“顺时针转 N 个四分之一圈、再在转后画面上翻转”得到朝向，再截取矩形。

use serde::{Deserialize, Serialize};

use crate::encode::RgbaView;
use crate::error::ImagingError;
use crate::thumb::Decoded;

/// 裁剪矩形，单位像素，坐标相对转后（旋转、翻转之后）的画面。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// 顺时针转 `quarter_turns` 个 90° 后的宽高（只看奇偶）。
pub fn oriented_dims(w: u32, h: u32, quarter_turns: u8) -> (u32, u32) {
    if quarter_turns % 2 == 1 {
        (h, w)
    } else {
        (w, h)
    }
}

/// 先顺时针转 `quarter_turns` × 90°，再在转后的画面上水平 / 垂直翻转。
/// `quarter_turns` 按 4 取模；调用方负责拒绝大于 3 的输入。
pub fn orient(src: RgbaView, quarter_turns: u8, flip_h: bool, flip_v: bool) -> Decoded {
    let (sw, sh) = (src.width as usize, src.height as usize);
    let turns = quarter_turns % 4;
    let (dw, dh) = oriented_dims(src.width, src.height, turns);
    let (dw, dh) = (dw as usize, dh as usize);
    if turns == 0 && !flip_h && !flip_v {
        return Decoded {
            width: src.width,
            height: src.height,
            rgba: src.data.to_vec(),
        };
    }
    let mut out = vec![0u8; dw * dh * 4];
    for y in 0..sh {
        for x in 0..sw {
            let (mut tx, mut ty) = match turns {
                0 => (x, y),
                1 => (sh - 1 - y, x),
                2 => (sw - 1 - x, sh - 1 - y),
                _ => (y, sw - 1 - x),
            };
            if flip_h {
                tx = dw - 1 - tx;
            }
            if flip_v {
                ty = dh - 1 - ty;
            }
            let s = (y * sw + x) * 4;
            let d = (ty * dw + tx) * 4;
            out[d..d + 4].copy_from_slice(&src.data[s..s + 4]);
        }
    }
    Decoded {
        width: dw as u32,
        height: dh as u32,
        rgba: out,
    }
}

/// 截取矩形；宽高为 0 或超出图片返回 `InvalidParams`。
pub fn crop_rgba(src: RgbaView, rect: CropRect) -> Result<Decoded, ImagingError> {
    if rect.w == 0 || rect.h == 0 {
        return Err(ImagingError::InvalidParams("裁剪区域不能为空"));
    }
    let right = u64::from(rect.x) + u64::from(rect.w);
    let bottom = u64::from(rect.y) + u64::from(rect.h);
    if right > u64::from(src.width) || bottom > u64::from(src.height) {
        return Err(ImagingError::InvalidParams("裁剪区域超出图片"));
    }
    let sw = src.width as usize;
    let (rw, rh) = (rect.w as usize, rect.h as usize);
    let mut rgba = Vec::with_capacity(rw * rh * 4);
    for row in 0..rh {
        let start = ((rect.y as usize + row) * sw + rect.x as usize) * 4;
        rgba.extend_from_slice(&src.data[start..start + rw * 4]);
    }
    Ok(Decoded {
        width: rect.w,
        height: rect.h,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 第 i 个像素编号为 [i, 0, 0, 255]。
    fn numbered(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).flat_map(|i| [i as u8, 0, 0, 255]).collect()
    }

    fn view(w: u32, h: u32, d: &[u8]) -> RgbaView<'_> {
        RgbaView {
            width: w,
            height: h,
            data: d,
        }
    }

    fn ids(d: &Decoded) -> Vec<u8> {
        d.rgba.chunks_exact(4).map(|p| p[0]).collect()
    }

    #[test]
    fn two_by_one_cases() {
        let d = numbered(2, 1); // [0,1] = [A,B]
        let o = orient(view(2, 1, &d), 1, false, false);
        assert_eq!((o.width, o.height), (1, 2));
        assert_eq!(ids(&o), vec![0, 1]);
        let o = orient(view(2, 1, &d), 1, false, true);
        assert_eq!(ids(&o), vec![1, 0]);
        let o = orient(view(2, 1, &d), 2, false, false);
        assert_eq!(ids(&o), vec![1, 0]);
        let o = orient(view(2, 1, &d), 0, true, false);
        assert_eq!(ids(&o), vec![1, 0]);
    }

    /// 参照实现：逐次顺时针转一圈 (x,y)→(H-1-y, x)，再翻转。
    fn reference(w: u32, h: u32, turns: u8, fh: bool, fv: bool) -> (u32, u32, Vec<u8>) {
        let mut cur: Vec<((u32, u32), u8)> = (0..h)
            .flat_map(|y| (0..w).map(move |x| ((x, y), (y * w + x) as u8)))
            .collect();
        let (mut cw, mut ch) = (w, h);
        for _ in 0..turns {
            for ((x, y), _) in cur.iter_mut() {
                (*x, *y) = (ch - 1 - *y, *x);
            }
            (cw, ch) = (ch, cw);
        }
        for ((x, y), _) in cur.iter_mut() {
            if fh {
                *x = cw - 1 - *x;
            }
            if fv {
                *y = ch - 1 - *y;
            }
        }
        let mut out = vec![0u8; (cw * ch) as usize];
        for ((x, y), v) in cur {
            out[(y * cw + x) as usize] = v;
        }
        (cw, ch, out)
    }

    #[test]
    fn three_by_two_all_sixteen() {
        let d = numbered(3, 2);
        for turns in 0..4u8 {
            for fh in [false, true] {
                for fv in [false, true] {
                    let o = orient(view(3, 2, &d), turns, fh, fv);
                    let (w, h, exp) = reference(3, 2, turns, fh, fv);
                    assert_eq!((o.width, o.height), (w, h), "{turns} {fh} {fv}");
                    assert_eq!(ids(&o), exp, "{turns} {fh} {fv}");
                }
            }
        }
    }

    #[test]
    fn dims() {
        assert_eq!(oriented_dims(3, 2, 1), (2, 3));
        assert_eq!(oriented_dims(3, 2, 2), (3, 2));
        assert_eq!(oriented_dims(3, 2, 3), (2, 3));
        assert_eq!(oriented_dims(3, 2, 0), (3, 2));
    }

    #[test]
    fn crop_extracts() {
        let d = numbered(3, 2);
        let c = crop_rgba(
            view(3, 2, &d),
            CropRect {
                x: 1,
                y: 0,
                w: 2,
                h: 2,
            },
        )
        .unwrap();
        assert_eq!((c.width, c.height), (2, 2));
        assert_eq!(ids(&c), vec![1, 2, 4, 5]);
    }

    #[test]
    fn crop_rejects_bad_rects() {
        let d = numbered(3, 2);
        for r in [
            CropRect {
                x: 0,
                y: 0,
                w: 0,
                h: 1,
            },
            CropRect {
                x: 0,
                y: 0,
                w: 1,
                h: 0,
            },
            CropRect {
                x: 2,
                y: 0,
                w: 2,
                h: 1,
            },
            CropRect {
                x: 0,
                y: 1,
                w: 1,
                h: 2,
            },
            CropRect {
                x: u32::MAX,
                y: 0,
                w: 2,
                h: 1,
            },
        ] {
            assert!(matches!(
                crop_rgba(view(3, 2, &d), r),
                Err(ImagingError::InvalidParams(_))
            ));
        }
    }
}
