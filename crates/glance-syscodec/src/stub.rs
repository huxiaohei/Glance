//! 没有接入系统解码器的目标：一律 NoCodec。

use crate::{CodecError, Image, Kind};

pub(crate) fn decode(
    _bytes: &[u8],
    _kind: Kind,
    _max_pixels: u64,
    _max_edge: Option<u32>,
) -> Result<Image, CodecError> {
    Err(CodecError::NoCodec)
}
