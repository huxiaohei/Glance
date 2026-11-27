//! Windows 上的冒烟测试：任何输入都不 panic；内嵌的小 AVIF 要么解对，要么报 NoCodec（本机没装扩展）。
//! 样张 `tests/data/tiny.avif`（8×6，左半红、右半蓝，sRGB，不透明）由 `roundtrip.rs` 里被忽略的
//! `write_tiny_avif_fixture` 在 macOS 上现编，自制，无许可问题；`tiny_fixture.rs` 在 macOS 上验证它有效。
#![cfg(windows)]

use glance_syscodec::{CodecError, Kind, decode};

const TINY_AVIF: &[u8] = include_bytes!("data/tiny.avif");

#[test]
fn garbage_never_panics() {
    // 确定性的伪随机字节。
    let mut s: u32 = 0x1234_5678;
    let mut noise = Vec::with_capacity(4096);
    for _ in 0..4096 {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        noise.push((s >> 24) as u8);
    }
    // 只有 ftyp 盒子的 HEIC 与 AVIF。
    let mut heic_ftyp = vec![0, 0, 0, 24];
    heic_ftyp.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
    let mut avif_ftyp = vec![0, 0, 0, 24];
    avif_ftyp.extend_from_slice(b"ftypavif\0\0\0\0mif1avif");
    // ftyp 后面跟着随机字节。
    let mut heic_noise = heic_ftyp.clone();
    heic_noise.extend_from_slice(&noise);
    // 截断的样张。
    let cut = &TINY_AVIF[..TINY_AVIF.len() / 2];

    let inputs: [&[u8]; 7] = [
        &[],
        &[0; 3],
        &noise,
        &heic_ftyp,
        &avif_ftyp,
        &heic_noise,
        cut,
    ];
    for (i, bytes) in inputs.iter().enumerate() {
        for kind in [Kind::Heif, Kind::Avif] {
            let got = decode(bytes, kind, u64::MAX, None);
            eprintln!(
                "输入 {i}（{} 字节）按 {kind:?}：{:?}",
                bytes.len(),
                got.as_ref().map(|img| (img.width, img.height))
            );
            assert!(got.is_err(), "输入 {i} 按 {kind:?} 不该解出图");
        }
    }
}

#[test]
fn result_is_ok_or_no_codec() {
    match decode(TINY_AVIF, Kind::Avif, u64::MAX, None) {
        Ok(img) => {
            eprintln!(
                "结果：Ok（{}×{}，ICC {}，左上 {:?}，右上 {:?}）",
                img.width,
                img.height,
                img.icc
                    .as_ref()
                    .map_or("无".to_owned(), |b| format!("{} 字节", b.len())),
                &img.rgba[..4],
                &img.rgba[(7 * 4)..(8 * 4)],
            );
            assert_eq!((img.width, img.height), (8, 6));
            assert_eq!(img.rgba.len(), 8 * 6 * 4);
            // 左半红、右半蓝，不透明。
            let left: [u8; 4] = img.rgba[..4].try_into().unwrap();
            let right: [u8; 4] = img.rgba[(7 * 4)..(8 * 4)].try_into().unwrap();
            let (l, r) = (left.map(i32::from), right.map(i32::from));
            assert!(l[0] - l[2] > 100, "左上应是红色：{left:?}");
            assert!(r[2] - r[0] > 100, "右上应是蓝色：{right:?}");
            assert_eq!((left[3], right[3]), (255, 255));

            // 给了 max_edge 就缩小，不放大。
            let small = decode(TINY_AVIF, Kind::Avif, u64::MAX, Some(4)).expect("缩小");
            assert_eq!((small.width, small.height), (4, 3));
            assert_eq!(small.rgba.len(), 4 * 3 * 4);
            let same = decode(TINY_AVIF, Kind::Avif, u64::MAX, Some(100)).expect("不放大");
            assert_eq!((same.width, same.height), (8, 6));
            // 没给 max_edge 且超出像素上限。
            assert_eq!(
                decode(TINY_AVIF, Kind::Avif, 47, None).err(),
                Some(CodecError::TooLarge)
            );
        }
        Err(CodecError::NoCodec) => {
            eprintln!("结果：NoCodec（本机没装 AVIF 解码组件）");
        }
        Err(e) => panic!("期望 Ok 或 NoCodec，得到 {e:?}"),
    }
}

#[test]
fn decodes_from_worker_threads() {
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                s.spawn(|| {
                    for _ in 0..5 {
                        match decode(TINY_AVIF, Kind::Avif, u64::MAX, None) {
                            Ok(img) => assert_eq!((img.width, img.height), (8, 6)),
                            Err(CodecError::NoCodec) => return,
                            Err(e) => panic!("工作线程里解码失败：{e:?}"),
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("工作线程");
        }
    });
}
