//! WIC 返回的 HRESULT 到 [`CodecError`] 的映射。
//!
//! 纯函数、只认数值，所以在任何平台上都能编译和测试；Windows 实现里所有 WIC 调用的失败都经这里。

use crate::CodecError;

/// WINCODEC_ERR_COMPONENTNOTFOUND（0x88982F50）：找不到能处理的组件（编解码器没装）。
const COMPONENT_NOT_FOUND: i32 = 0x8898_2F50_u32 as i32;
/// WINCODEC_ERR_UNKNOWNIMAGEFORMAT（0x88982F07）：没有解码器认得这种格式。
/// 调用方已用文件头确认是 HEIF / AVIF，所以这也说明本机缺组件。
const UNKNOWN_IMAGE_FORMAT: i32 = 0x8898_2F07_u32 as i32;

/// 缺组件 → NoCodec；其余失败 → Decode（带上错误码，便于对照 E5 的实测）。
pub(crate) fn map_hresult(hr: i32) -> CodecError {
    match hr {
        COMPONENT_NOT_FOUND | UNKNOWN_IMAGE_FORMAT => CodecError::NoCodec,
        _ => CodecError::Decode(format!("系统解码失败（0x{:08X}）", hr as u32)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_component_is_no_codec() {
        assert_eq!(map_hresult(0x8898_2F50_u32 as i32), CodecError::NoCodec);
    }

    #[test]
    fn unknown_format_is_no_codec() {
        assert_eq!(map_hresult(0x8898_2F07_u32 as i32), CodecError::NoCodec);
    }

    #[test]
    fn other_failures_are_decode_errors_with_code() {
        // WINCODEC_ERR_BADHEADER、E_FAIL、E_OUTOFMEMORY、WINCODEC_ERR_COMPONENTINITIALIZEFAILURE。
        for hr in [0x8898_2F61_u32, 0x8000_4005, 0x8007_000E, 0x8898_2F8B] {
            match map_hresult(hr as i32) {
                CodecError::Decode(msg) => {
                    assert!(msg.contains(&format!("{hr:08X}")), "{msg}");
                }
                other => panic!("{hr:08X} 期望 Decode，得到 {other:?}"),
            }
        }
    }
}
