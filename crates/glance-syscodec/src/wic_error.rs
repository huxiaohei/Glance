//! WIC 返回的 HRESULT 到 [`CodecError`] 的映射。
//!
//! 纯函数、只认数值，所以在任何平台上都能编译和测试；Windows 实现里所有 WIC 调用的失败都经这里。

use crate::CodecError;

/// WINCODEC_ERR_COMPONENTNOTFOUND（0x88982F50）：找不到能处理的组件（编解码器没装）。
const COMPONENT_NOT_FOUND: i32 = 0x8898_2F50_u32 as i32;
/// WINCODEC_ERR_COMPONENTINITIALIZEFAILURE（0x88982F8B）：组件在，但初始化失败。
/// 实测（Windows CI，2026-11-27）：装了 HEIF 容器组件、缺视频解码组件时，解 AVIF 报的是这个码。
const COMPONENT_INIT_FAILURE: i32 = 0x8898_2F8B_u32 as i32;
/// WINCODEC_ERR_UNKNOWNIMAGEFORMAT（0x88982F07）：没有解码器认得这种格式。
const UNKNOWN_IMAGE_FORMAT: i32 = 0x8898_2F07_u32 as i32;

/// 创建解码器（`CreateDecoderFromStream`）这一步的失败：缺组件或“不认识的格式”→ NoCodec。
/// 调用方已用文件头确认是 HEIF / AVIF，所以这一步不认识格式说明本机缺组件。
pub(crate) fn map_create_hresult(hr: i32) -> CodecError {
    match hr {
        UNKNOWN_IMAGE_FORMAT => CodecError::NoCodec,
        _ => map_hresult(hr),
    }
}

/// 其余各步的失败：只有缺组件（找不到，或组件初始化失败）→ NoCodec；其余（含“不认识的格式”）→ Decode，
/// 带上错误码，便于对照 E5 的实测。解码器已建好之后再报“不认识”，是这份文件的问题，不是缺组件。
pub(crate) fn map_hresult(hr: i32) -> CodecError {
    match hr {
        COMPONENT_NOT_FOUND | COMPONENT_INIT_FAILURE => CodecError::NoCodec,
        _ => CodecError::Decode(format!("系统解码失败（0x{:08X}）", hr as u32)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOT_FOUND: i32 = 0x8898_2F50_u32 as i32;
    const UNKNOWN: i32 = 0x8898_2F07_u32 as i32;

    #[test]
    fn missing_component_is_no_codec_at_every_step() {
        assert_eq!(map_hresult(NOT_FOUND), CodecError::NoCodec);
        assert_eq!(map_create_hresult(NOT_FOUND), CodecError::NoCodec);
    }

    /// Windows CI（windows-latest，2026-11-27）上解一张 AVIF 得到的就是这个码：
    /// 容器组件在、视频解码组件起不来。
    #[test]
    fn component_init_failure_is_no_codec_at_every_step() {
        const INIT_FAILURE: i32 = 0x8898_2F8B_u32 as i32;
        assert_eq!(map_hresult(INIT_FAILURE), CodecError::NoCodec);
        assert_eq!(map_create_hresult(INIT_FAILURE), CodecError::NoCodec);
    }

    #[test]
    fn unknown_format_is_no_codec_only_when_creating_the_decoder() {
        assert_eq!(map_create_hresult(UNKNOWN), CodecError::NoCodec);
        match map_hresult(UNKNOWN) {
            CodecError::Decode(msg) => assert!(msg.contains("88982F07"), "{msg}"),
            other => panic!("期望 Decode，得到 {other:?}"),
        }
    }

    #[test]
    fn other_failures_are_decode_errors_with_code() {
        // WINCODEC_ERR_BADHEADER、E_FAIL、E_OUTOFMEMORY。
        for hr in [0x8898_2F61_u32, 0x8000_4005, 0x8007_000E] {
            for map in [map_hresult, map_create_hresult] {
                match map(hr as i32) {
                    CodecError::Decode(msg) => {
                        assert!(msg.contains(&format!("{hr:08X}")), "{msg}");
                    }
                    other => panic!("{hr:08X} 期望 Decode，得到 {other:?}"),
                }
            }
        }
    }
}
