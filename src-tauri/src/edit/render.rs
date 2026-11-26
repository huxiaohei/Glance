//! 由文件直接产出编辑结果：读文件、解码、按参数编码，不经编辑会话。
//! 批量任务与会话里的“全尺寸保存”共用同一套 `apply`，同一张图同一组参数得到逐字节相同的结果。

use std::panic::AssertUnwindSafe;
use std::path::Path;

use glance_imaging::{
    Decoded, EditParams, Encoded, RgbaView, SrcFormat, apply, decode_rgba_icc, src_format_of,
};

use super::session::{EditError, MAX_PIXELS, out_format};
use crate::catalog::details::image_details;

/// 解码好的源图（已按 EXIF 方向转正）。
pub struct Source {
    pub src_format: SrcFormat,
    pub icc: Option<Vec<u8>>,
    pub decoded: Decoded,
    pub file_size: u64,
}

/// 读文件并解码。动图是 `Animated`，读不到是 `NotFound`，认不出格式是 `Unsupported`。
/// 读文件与解码在调用方线程上做，调用方不得是主线程。
pub fn read_source(path: &Path) -> Result<Source, EditError> {
    let details = image_details(path).ok_or(EditError::NotFound)?;
    if details.animated {
        return Err(EditError::Animated);
    }
    let bytes = std::fs::read(path).map_err(|_| EditError::NotFound)?;
    let src_format = src_format_of(&bytes).ok_or(EditError::Unsupported)?;
    let d = decode_rgba_icc(&bytes, MAX_PIXELS)?;
    Ok(Source {
        src_format,
        icc: d.icc,
        decoded: d.decoded,
        file_size: bytes.len() as u64,
    })
}

/// 批量只支持 Compress / Convert：不经会话的 RemoveBg 透明度闸门。
/// 读文件、按参数编码；返回编码结果、源格式与原文件大小。压缩 GIF / BMP 是 `Unsupported`；
/// 编码时 panic 记作 `Encode`。
pub fn render_path(
    path: &Path,
    params: &EditParams,
) -> Result<(Encoded, SrcFormat, u64), EditError> {
    let src = read_source(path)?;
    out_format(src.src_format, params)?;
    let view = RgbaView {
        width: src.decoded.width,
        height: src.decoded.height,
        data: &src.decoded.rgba,
    };
    let out = std::panic::catch_unwind(AssertUnwindSafe(|| {
        apply(view, src.src_format, src.icc.as_deref(), params)
    }));
    match out {
        Ok(Ok(enc)) => Ok((enc, src.src_format, src.file_size)),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(EditError::Encode),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::details::testimg::gif;
    use crate::catalog::registry::Registry;
    use crate::edit::EditState;
    use glance_imaging::{OutFormat, PngMode, encode_png_lossless};

    fn write_png(path: &Path, w: u32, h: u32) {
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w) as u8, (i / w) as u8, ((i * 7) % 251) as u8, 255])
            .collect();
        let bytes = encode_png_lossless(
            RgbaView {
                width: w,
                height: h,
                data: &data,
            },
            None,
        )
        .unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn render_matches_session_save() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        write_png(&p, 64, 48);
        let reg = Registry::default();
        let id = reg.register(&p);
        let st = EditState::default();
        let o = st.open(&reg, id).unwrap();
        let cases = [
            EditParams::Compress {
                quality: 80,
                max_edge: None,
                png_mode: PngMode::Lossless,
            },
            EditParams::Convert {
                format: OutFormat::Webp,
                quality: 85,
                fill: [255; 3],
            },
        ];
        for params in cases {
            let a = st.compute_full(o.session, &params).unwrap();
            let (b, fmt, size) = render_path(&p, &params).unwrap();
            assert_eq!(a.bytes, b.bytes);
            assert_eq!(a.format, b.format);
            assert_eq!(fmt, SrcFormat::Png);
            assert_eq!(size, std::fs::metadata(&p).unwrap().len());
        }
    }

    #[test]
    fn render_rejects_compress_gif() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("one.gif");
        std::fs::write(&p, gif(1)).unwrap();
        let compress = EditParams::Compress {
            quality: 80,
            max_edge: None,
            png_mode: PngMode::Lossless,
        };
        assert!(matches!(
            render_path(&p, &compress),
            Err(EditError::Unsupported)
        ));
        let to_png = EditParams::Convert {
            format: OutFormat::Png,
            quality: 90,
            fill: [255; 3],
        };
        assert!(render_path(&p, &to_png).is_ok());
    }

    #[test]
    fn render_rejects_animated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("anim.gif");
        std::fs::write(&p, gif(2)).unwrap();
        let to_png = EditParams::Convert {
            format: OutFormat::Png,
            quality: 90,
            fill: [255; 3],
        };
        assert!(matches!(render_path(&p, &to_png), Err(EditError::Animated)));
    }
}
