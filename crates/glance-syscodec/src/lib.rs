//! 用操作系统自带的编解码器把内存里的 HEIC / HEIF / AVIF 解成 RGBA8 与 ICC。
//!
//! 只接收内存字节，不打开文件；可在任意后台线程并发调用；对任何输入都不 panic。
//! macOS 走 ImageIO / CoreGraphics；Windows 走 WIC；其他目标恒返回 [`CodecError::NoCodec`]。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[cfg(not(any(target_os = "macos", windows)))]
mod stub;
#[cfg(not(any(target_os = "macos", windows)))]
use stub as imp;

// 错误码映射是纯函数：Windows 上给实现用，其他平台只为跑它的单元测试而编译。
#[cfg(any(windows, test))]
mod wic_error;

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

/// 把 `w` × `h` 等比缩到长边不超过 `edge`（不放大）；短边四舍五入，至少 1。
#[cfg_attr(not(windows), allow(dead_code))]
fn fit_within(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long == 0 {
        return (w, h);
    }
    let target = edge.clamp(1, long);
    // u32 × u32 放得进 u64；结果不超过原短边，转回 u32 不会截断。
    let scale = |side: u32| -> u32 {
        let v = (u64::from(side) * u64::from(target) + u64::from(long) / 2) / u64::from(long);
        u32::try_from(v).unwrap_or(side).max(1)
    };
    if w >= h {
        (target, scale(h))
    } else {
        (scale(w), target)
    }
}

/// 顶层 ISOBMFF 盒子是否都完整落在 `bytes` 里。
///
/// 系统解码器对截断的文件常常照样画出半张图、状态也报“完整”，所以先自己核一遍：
/// 每个顶层盒子声明的长度都不能超出文件末尾；末尾剩下的不足一个盒子头的字节只允许是全 0 的填充。
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn boxes_complete(bytes: &[u8]) -> bool {
    let len = bytes.len() as u64;
    let mut pos: u64 = 0;
    let mut seen = false;
    while pos < len {
        let rest = &bytes[pos as usize..];
        if rest.len() < 8 {
            return seen && rest.iter().all(|&b| b == 0);
        }
        let (size, header) = match u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) {
            0 => (len - pos, 8),
            1 => {
                let Some(large) = rest.get(8..16) else {
                    return false;
                };
                let mut b = [0u8; 8];
                b.copy_from_slice(large);
                (u64::from_be_bytes(b), 16)
            }
            n => (u64::from(n), 8),
        };
        if size < header || size > len - pos {
            return false;
        }
        pos += size;
        seen = true;
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fbox(fourcc: &[u8; 4], body: usize) -> Vec<u8> {
        let mut b = ((8 + body) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(fourcc);
        b.resize(8 + body, 7);
        b
    }

    #[test]
    fn boxes_complete_checks_declared_lengths() {
        let mut file = fbox(b"ftyp", 16);
        file.extend(fbox(b"meta", 40));
        file.extend(fbox(b"mdat", 100));
        assert!(boxes_complete(&file));
        // 截在最后一个盒子里、截在盒子头里，都不算完整。
        assert!(!boxes_complete(&file[..file.len() - 1]));
        assert!(!boxes_complete(&file[..24 + 48 + 4]));
        // 末尾不足一个盒子头的 0 填充可以接受，非 0 的不行。
        let mut padded = file.clone();
        padded.extend_from_slice(&[0, 0, 0]);
        assert!(boxes_complete(&padded));
        padded.push(9);
        assert!(!boxes_complete(&padded));
        // size = 0 表示延伸到文件末尾。
        let mut to_end = fbox(b"ftyp", 16);
        to_end.extend_from_slice(&[0, 0, 0, 0]);
        to_end.extend_from_slice(b"mdat");
        to_end.extend_from_slice(&[1, 2, 3]);
        assert!(boxes_complete(&to_end));
        // 64 位长度。
        let mut large = fbox(b"ftyp", 16);
        large.extend_from_slice(&1u32.to_be_bytes());
        large.extend_from_slice(b"mdat");
        large.extend_from_slice(&20u64.to_be_bytes());
        large.extend_from_slice(&[5, 5, 5, 5]);
        assert!(boxes_complete(&large));
        assert!(!boxes_complete(&large[..large.len() - 1]));
        // 长度小于盒子头、空输入。
        assert!(!boxes_complete(&[0, 0, 0, 4, b'f', b't', b'y', b'p']));
        assert!(!boxes_complete(&[]));
    }

    #[test]
    fn fit_within_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_within(64, 48, 16), (16, 12));
        assert_eq!(fit_within(48, 64, 16), (12, 16));
        assert_eq!(fit_within(100, 100, 30), (30, 30));
        // 不放大；edge 为 0 时按 1 算。
        assert_eq!(fit_within(64, 48, 1000), (64, 48));
        assert_eq!(fit_within(64, 48, 0), (1, 1));
        // 短边四舍五入，至少 1。
        assert_eq!(fit_within(1000, 3, 10), (10, 1));
        assert_eq!(fit_within(300, 200, 100), (100, 67));
        // 极端尺寸不溢出。
        assert_eq!(fit_within(u32::MAX, u32::MAX - 1, 8000), (8000, 8000));
        assert_eq!(fit_within(u32::MAX, 1, 8000), (8000, 1));
    }

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
