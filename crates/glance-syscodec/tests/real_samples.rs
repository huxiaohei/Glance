//! 真实样张（手机拍的 HEIC、各家导出的 AVIF）逐个解码，宽高须与文件头解析一致。
//! 样张不进 git：放到仓库根目录的 `fixtures/heic/` 下，再运行
//! `cargo test -p glance-syscodec --test real_samples -- --ignored`。

use std::fs::File;
use std::path::PathBuf;

use glance_imaging::heif::{self, HeifKind};
use glance_syscodec::{CodecError, Kind, decode};

fn samples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/heic")
}

#[test]
#[ignore = "需要本机 fixtures/heic/ 下的真实样张"]
fn real_samples_decode_with_header_dims() {
    let dir = samples_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!(
            "跳过：没有样张目录。把 .heic / .heif / .avif 文件放到 {} 后重跑。",
            dir.display()
        );
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    paths.sort();

    let mut checked = 0;
    for path in paths {
        let bytes = std::fs::read(&path).expect("读样张");
        let Some(kind) = heif::sniff(&bytes) else {
            eprintln!("忽略（不是 HEIF / AVIF）：{}", path.display());
            continue;
        };
        let info = heif::parse(&mut File::open(&path).expect("打开样张"))
            .unwrap_or_else(|| panic!("文件头解析失败：{}", path.display()));
        let kind = match kind {
            HeifKind::Heic => Kind::Heif,
            HeifKind::Avif => Kind::Avif,
        };
        match decode(&bytes, kind, u64::MAX, None) {
            Ok(img) => {
                assert_eq!(
                    (img.width, img.height),
                    info.display_dims(),
                    "{}",
                    path.display()
                );
                assert_eq!(img.rgba.len(), img.width as usize * img.height as usize * 4);
                eprintln!(
                    "通过：{}（{}×{}，ICC {}）",
                    path.display(),
                    img.width,
                    img.height,
                    if img.icc.is_some() { "有" } else { "无" }
                );
                checked += 1;
            }
            Err(CodecError::NoCodec) => {
                eprintln!("跳过（本机没有 {kind:?} 解码器）：{}", path.display());
            }
            Err(e) => panic!("{} 解码失败：{e:?}", path.display()),
        }
    }
    eprintln!("共核对 {checked} 张");
}
