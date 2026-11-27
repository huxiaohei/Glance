//! 由文件直接产出编辑结果：读文件、解码、按参数编码，不经编辑会话。
//! 批量任务与会话里的“全尺寸保存”共用同一套 `apply`，同一张图同一组参数得到逐字节相同的结果。

use std::panic::AssertUnwindSafe;
use std::path::Path;

use glance_imaging::{Decoded, EditParams, Encoded, RgbaView, SrcFormat, apply, src_format_of};

use super::session::{EditError, MAX_PIXELS, out_format};
use crate::catalog::details::{exif_blob, image_details};
use crate::decode::{self, DecodeError};

/// 解码好的源图（已按 EXIF 方向转正）。
pub struct Source {
    pub src_format: SrcFormat,
    pub icc: Option<Vec<u8>>,
    /// 源文件里的原始 EXIF（TIFF 结构）；输出 JPEG / WebP 时由 `apply` 按输出尺寸改写后带上。
    pub exif: Option<Vec<u8>>,
    pub decoded: Decoded,
    pub file_size: u64,
    /// 整张图是否有非不透明像素（HEIC / AVIF 裁剪据此选输出格式，去背景页据此提示）。
    pub has_alpha: bool,
}

/// 整张图里有没有非不透明的像素。
pub(super) fn any_transparent(d: &Decoded) -> bool {
    d.rgba.chunks_exact(4).any(|p| p[3] != 255)
}

/// 读文件并解码。动图是 `Animated`，读不到是 `NotFound`，认不出格式是 `Unsupported`。
/// 读文件与解码在调用方线程上做，调用方不得是主线程。
pub fn read_source(path: &Path) -> Result<Source, EditError> {
    read_source_with(path, &mut |_| {})
}

/// after_read 在读完文件之后调用，测试借此在读完之后改写文件。
fn read_source_with(path: &Path, after_read: &mut dyn FnMut(&Path)) -> Result<Source, EditError> {
    let details = image_details(path).ok_or(EditError::NotFound)?;
    if details.animated {
        return Err(EditError::Animated);
    }
    let bytes = std::fs::read(path).map_err(|_| EditError::NotFound)?;
    after_read(path);
    let src_format = src_format_of(&bytes).ok_or(EditError::Unsupported)?;
    let d = decode::decode(&bytes, MAX_PIXELS).map_err(|e| match e {
        DecodeError::TooLarge => EditError::TooLarge,
        // 本机缺系统解码器暂且算解不出来，以后换成专门的错误。
        DecodeError::NoCodec | DecodeError::Decode => EditError::Decode,
    })?;
    let has_alpha = any_transparent(&d.decoded);
    Ok(Source {
        src_format,
        icc: d.icc,
        exif: exif_blob(&bytes),
        decoded: d.decoded,
        file_size: bytes.len() as u64,
        has_alpha,
    })
}

/// 批量只支持 Compress / Convert：不经会话的 RemoveBg 透明度闸门。
/// 读文件、按参数编码；返回编码结果、源格式与原文件大小。压缩 GIF / BMP / HEIC / AVIF 是 `Unsupported`；
/// 编码时 panic 记作 `Encode`。
pub fn render_path(
    path: &Path,
    params: &EditParams,
) -> Result<(Encoded, SrcFormat, u64), EditError> {
    let src = read_source(path)?;
    out_format(src.src_format, src.has_alpha, params)?;
    let view = RgbaView {
        width: src.decoded.width,
        height: src.decoded.height,
        data: &src.decoded.rgba,
    };
    let out = std::panic::catch_unwind(AssertUnwindSafe(|| {
        apply(
            view,
            src.src_format,
            src.has_alpha,
            src.icc.as_deref(),
            src.exif.as_deref(),
            params,
        )
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
    use crate::catalog::details::testimg::{gif, png};
    use crate::catalog::registry::Registry;
    use crate::edit::EditState;
    use glance_imaging::{OutFormat, PngMode};

    /// 带拍摄信息（厂商、型号）的 JPEG 源图。
    fn write_jpeg_with_exif(path: &Path, w: u32, h: u32) {
        use crate::catalog::details::testimg::{MAKE, MODEL, V, jpeg_with_exif, tiff};
        let blob = tiff(
            &[(MAKE, V::Ascii("Acme")), (MODEL, V::Ascii("Model 9000"))],
            &[(0xA002, V::Long(w)), (0xA003, V::Long(h))],
        );
        std::fs::write(path, jpeg_with_exif(w, h, &blob)).unwrap();
    }

    fn make_of(bytes: &[u8]) -> Option<String> {
        let x = exif::Reader::new()
            .read_from_container(&mut std::io::Cursor::new(bytes))
            .ok()?;
        Some(
            x.get_field(exif::Tag::Make, exif::In::PRIMARY)?
                .display_value()
                .to_string(),
        )
    }

    /// WebP 的 RIFF 块：(类型, 内容)。
    fn webp_chunks(b: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        assert_eq!(&b[..4], b"RIFF");
        assert_eq!(&b[8..12], b"WEBP");
        let mut out = Vec::new();
        let mut pos = 12;
        while pos + 8 <= b.len() {
            let len = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
            out.push((
                b[pos..pos + 4].try_into().unwrap(),
                b[pos + 8..pos + 8 + len].to_vec(),
            ));
            pos += 8 + len + (len & 1);
        }
        assert_eq!(pos, b.len());
        out
    }

    /// 原始 TIFF 结构的 EXIF 里的厂商。
    fn make_of_tiff(tiff: &[u8]) -> Option<String> {
        let x = exif::Reader::new().read_raw(tiff.to_vec()).ok()?;
        Some(
            x.get_field(exif::Tag::Make, exif::In::PRIMARY)?
                .display_value()
                .to_string(),
        )
    }

    #[test]
    fn render_matches_session_save() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        write_jpeg_with_exif(&p, 64, 48);
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
            EditParams::Convert {
                format: OutFormat::Png,
                quality: 85,
                fill: [255; 3],
            },
        ];
        for params in cases {
            let a = st.compute_full(o.session, &params).unwrap();
            let (b, fmt, size) = render_path(&p, &params).unwrap();
            assert_eq!(a.bytes, b.bytes);
            assert_eq!(a.format, b.format);
            assert_eq!(fmt, SrcFormat::Jpeg);
            assert_eq!(size, std::fs::metadata(&p).unwrap().len());
            if b.format == OutFormat::Jpeg {
                assert_eq!(make_of(&b.bytes).as_deref(), Some("\"Acme\""));
            }
            if b.format == OutFormat::Webp {
                let chunks = webp_chunks(&b.bytes);
                let exif = chunks
                    .iter()
                    .find(|(kind, _)| kind == b"EXIF")
                    .map(|(_, body)| body)
                    .expect("WebP 里应有 EXIF 块");
                assert_eq!(make_of_tiff(exif).as_deref(), Some("\"Acme\""));
            }
            if b.format == OutFormat::Png {
                assert!(!b.bytes.windows(4).any(|w| w == b"eXIf"));
            }
        }

        // PNG 源图无损压缩：会话保存与 render_path 逐字节相同。
        let p = dir.path().join("b.png");
        std::fs::write(&p, png(64, 48)).unwrap();
        let o = st.open(&reg, reg.register(&p)).unwrap();
        let params = EditParams::Compress {
            quality: 80,
            max_edge: None,
            png_mode: PngMode::Lossless,
        };
        let a = st.compute_full(o.session, &params).unwrap();
        let (b, fmt, _) = render_path(&p, &params).unwrap();
        assert_eq!(fmt, SrcFormat::Png);
        assert_eq!(b.format, OutFormat::Png);
        assert_eq!(a.bytes, b.bytes);
    }

    #[test]
    fn exif_comes_from_the_bytes_that_were_decoded() {
        use crate::catalog::details::testimg::{MAKE, V, jpeg_with_exif, tiff};
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        write_jpeg_with_exif(&p, 64, 48);
        // 读完之后文件被换成另一张（尺寸、厂商都不同）：像素与 EXIF 都应来自读到的那一份。
        let other = jpeg_with_exif(32, 16, &tiff(&[(MAKE, V::Ascii("Other"))], &[]));
        let src = read_source_with(&p, &mut |path| std::fs::write(path, &other).unwrap()).unwrap();
        assert_eq!((src.decoded.width, src.decoded.height), (64, 48));
        let exif = src.exif.expect("应带回 EXIF");
        assert_eq!(make_of_tiff(&exif).as_deref(), Some("\"Acme\""));
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
