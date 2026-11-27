//! 用操作系统自带的编解码器把内存里的 HEIC / HEIF / AVIF 解成 RGBA8 与 ICC。
//!
//! 只接收内存字节，不打开文件；可在任意后台线程并发调用；对任何输入都不 panic。
//! macOS 走 ImageIO / CoreGraphics；其他目标恒返回 [`CodecError::NoCodec`]。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(not(target_os = "macos"))]
mod stub;
#[cfg(not(target_os = "macos"))]
use stub as imp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Heif,
    Avif,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// 本机系统没有这种格式的解码器。
    NoCodec,
    /// 有解码器，但这份字节解不出来。
    Decode(String),
    /// 没给 `max_edge`，而原图像素数超过 `max_pixels`。
    TooLarge,
}

pub struct Image {
    pub width: u32,
    pub height: u32,
    /// 逐行 RGBA8，非预乘，已按文件记录的方向摆正。
    pub rgba: Vec<u8>,
    /// 像素所在色彩空间的 ICC；像素已是 sRGB 时为 None。
    pub icc: Option<Vec<u8>>,
}

/// `max_edge` 为 Some 时长边缩到不超过它（不放大）。
/// 摆正后的宽 × 高（缩小前）超过 `max_pixels` 且没给 `max_edge` → TooLarge。
pub fn decode(
    bytes: &[u8],
    kind: Kind,
    max_pixels: u64,
    max_edge: Option<u32>,
) -> Result<Image, CodecError> {
    // 绑定层在“不该为空却为空”时会 panic；兜住它，保证公开接口不 panic。
    std::panic::catch_unwind(|| imp::decode(bytes, kind, max_pixels, max_edge))
        .unwrap_or_else(|_| Err(CodecError::Decode("系统解码器内部错误".into())))
}

/// 把预乘 alpha 的 RGBA8 就地还原成非预乘。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpremultiply_restores_straight_alpha() {
        let mut px = [64, 32, 0, 128, 10, 20, 30, 255, 5, 5, 5, 0, 200, 0, 0, 100];
        unpremultiply(&mut px);
        assert_eq!(
            px,
            [128, 64, 0, 128, 10, 20, 30, 255, 5, 5, 5, 0, 255, 0, 0, 100]
        );
    }
}
