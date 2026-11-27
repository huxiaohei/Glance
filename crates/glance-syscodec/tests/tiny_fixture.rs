//! `tests/data/tiny.avif` 是 Windows 冒烟测试内嵌的样张；这里在 macOS 上证明它本身是一张有效的 AVIF。
//! 样张由 `roundtrip.rs` 里被忽略的 `write_tiny_avif_fixture` 在本机现编（自制，无许可问题）。
#![cfg(target_os = "macos")]

use glance_syscodec::{CodecError, Kind, decode};

const TINY_AVIF: &[u8] = include_bytes!("data/tiny.avif");

#[test]
fn tiny_avif_fixture_decodes_with_expected_dims() {
    match decode(TINY_AVIF, Kind::Avif, u64::MAX, None) {
        Ok(img) => {
            assert_eq!((img.width, img.height), (8, 6));
            assert_eq!(img.rgba.len(), 8 * 6 * 4);
            // 左半红、右半蓝，不透明；`windows_smoke.rs` 用同样的判断。
            let left: [u8; 4] = img.rgba[..4].try_into().unwrap();
            let right: [u8; 4] = img.rgba[(7 * 4)..(8 * 4)].try_into().unwrap();
            let (l, r) = (left.map(i32::from), right.map(i32::from));
            assert!(l[0] - l[2] > 100, "左上应是红色：{left:?}");
            assert!(r[2] - r[0] > 100, "右上应是蓝色：{right:?}");
            assert_eq!((left[3], right[3]), (255, 255));
            // 与 `windows_smoke.rs` 相同的像素上限判断。缩小不在这里比：ImageIO 把 8×6 缩到长边 4
            // 时给的是 4×4（小图上的取整怪癖），Windows 一侧按 `fit_within` 是 4×3。
            assert_eq!(
                decode(TINY_AVIF, Kind::Avif, 47, None).err(),
                Some(CodecError::TooLarge)
            );
        }
        Err(CodecError::NoCodec) => eprintln!("跳过：本机没有 AVIF 解码器"),
        Err(e) => panic!("内嵌样张解不出来：{e:?}"),
    }
}
