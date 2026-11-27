//! 唯一的解码入口：按内容分派。文件头是 HEIF / AVIF 的 `ftyp` → 系统解码器（`glance-syscodec`）；
//! 其余交给 `glance-imaging`。只看内容，不看扩展名；只接收内存字节，不打开文件。
//!
//! 每个公开函数都有一个 `*_with` 版本承载逻辑，系统解码器、解码器状态与并发闸门由参数传入，
//! 测试里换成替身与局部实例；公开函数传真解码器与进程内唯一的那一份状态。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};

use glance_imaging::heif::{self, HeifKind};
use glance_imaging::{Decoded, DecodedWithIcc, ImagingError, RgbaView, Thumbnail};
use glance_syscodec::{CodecError, Image, Kind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// 本机系统没有这种格式的解码器。
    NoCodec,
    /// 有解码器（或不需要系统解码器），但这份字节解不出来。
    Decode,
    /// 像素数超过调用方给的上限。
    TooLarge,
}

/// 系统解码器的函数签名；测试里换成替身。
pub type SysDecode = fn(&[u8], Kind, u64, Option<u32>) -> Result<Image, CodecError>;

/// 显示通道输出的长边上限。
pub const DISPLAY_MAX_EDGE: u32 = 8000;
/// 显示通道同时在算的上限。
const DISPLAY_CONCURRENCY: usize = 2;

/// 每种系统格式的解码器是否可用：从每次系统解码的结果得知。
pub struct CodecState {
    heif: AtomicU8,
    avif: AtomicU8,
}

/// 显示通道的并发闸门：同时最多 `limit` 个持有者，其余等待。
pub struct Gate {
    busy: Mutex<usize>,
    freed: Condvar,
    limit: usize,
}

const UNKNOWN: u8 = 0;
const AVAILABLE: u8 = 1;
const MISSING: u8 = 2;

static CODECS: CodecState = CodecState::new();
static DISPLAY_GATE: Gate = Gate::new(DISPLAY_CONCURRENCY);

impl CodecState {
    pub const fn new() -> Self {
        CodecState {
            heif: AtomicU8::new(UNKNOWN),
            avif: AtomicU8::new(UNKNOWN),
        }
    }

    fn slot(&self, kind: Kind) -> &AtomicU8 {
        match kind {
            Kind::Heif => &self.heif,
            Kind::Avif => &self.avif,
        }
    }

    /// Some(true) 缺失，Some(false) 可用，None 还不知道。
    pub fn missing(&self, kind: Kind) -> Option<bool> {
        match self.slot(kind).load(Ordering::Relaxed) {
            AVAILABLE => Some(false),
            MISSING => Some(true),
            _ => None,
        }
    }

    fn record(&self, kind: Kind, missing: bool) {
        let v = if missing { MISSING } else { AVAILABLE };
        self.slot(kind).store(v, Ordering::Relaxed);
    }

    pub fn reset(&self) {
        self.heif.store(UNKNOWN, Ordering::Relaxed);
        self.avif.store(UNKNOWN, Ordering::Relaxed);
    }
}

impl Default for CodecState {
    fn default() -> Self {
        Self::new()
    }
}

impl Gate {
    pub const fn new(limit: usize) -> Self {
        Gate {
            busy: Mutex::new(0),
            freed: Condvar::new(),
            limit,
        }
    }

    /// 等到有空位再进入；返回的名额在离开作用域时归还（含 panic 展开）。
    fn enter(&self) -> Permit<'_> {
        let mut busy = lock(&self.busy);
        while *busy >= self.limit {
            busy = self.freed.wait(busy).unwrap_or_else(|e| e.into_inner());
        }
        *busy += 1;
        Permit(self)
    }
}

/// 计数本身不会因持有者 panic 而失真（只在加减时持锁），中毒的锁照常使用。
fn lock(m: &Mutex<usize>) -> std::sync::MutexGuard<'_, usize> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Permit<'a>(&'a Gate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *lock(&self.0.busy) -= 1;
        self.0.freed.notify_one();
    }
}

fn system_kind(bytes: &[u8]) -> Option<Kind> {
    heif::sniff(bytes).map(|k| match k {
        HeifKind::Heic => Kind::Heif,
        HeifKind::Avif => Kind::Avif,
    })
}

/// 调系统解码器，并按结果记下这种格式的解码器是否可用：只有 NoCodec 说明缺失。
fn system(
    sys: SysDecode,
    codecs: &CodecState,
    bytes: &[u8],
    kind: Kind,
    max_pixels: u64,
    max_edge: Option<u32>,
) -> Result<Image, DecodeError> {
    let r = sys(bytes, kind, max_pixels, max_edge);
    codecs.record(kind, matches!(r, Err(CodecError::NoCodec)));
    r.map_err(|e| match e {
        CodecError::NoCodec => DecodeError::NoCodec,
        CodecError::TooLarge => DecodeError::TooLarge,
        CodecError::Decode(_) => DecodeError::Decode,
    })
}

fn imaging_err(e: ImagingError) -> DecodeError {
    match e {
        ImagingError::TooLarge => DecodeError::TooLarge,
        _ => DecodeError::Decode,
    }
}

fn split(img: Image) -> DecodedWithIcc {
    DecodedWithIcc {
        decoded: Decoded {
            width: img.width,
            height: img.height,
            rgba: img.rgba,
        },
        icc: img.icc,
    }
}

/// 一套解码依赖：系统解码器、记录解码器可用与否的状态、显示通道的闸门。
/// 生产路径用 [`Decoder::SYSTEM`]；测试换成替身解码器与自己的状态。
#[derive(Clone, Copy)]
pub struct Decoder {
    pub sys: SysDecode,
    pub codecs: &'static CodecState,
    pub gate: &'static Gate,
}

impl Decoder {
    pub const SYSTEM: Decoder = Decoder {
        sys: glance_syscodec::decode,
        codecs: &CODECS,
        gate: &DISPLAY_GATE,
    };

    pub fn decode(&self, bytes: &[u8], max_pixels: u64) -> Result<DecodedWithIcc, DecodeError> {
        decode_with(self.sys, self.codecs, bytes, max_pixels)
    }

    pub fn thumbnail(&self, bytes: &[u8], max_edge: u32) -> Result<Thumbnail, DecodeError> {
        thumbnail_with(self.sys, self.codecs, bytes, max_edge)
    }

    pub fn display_png(&self, bytes: &[u8]) -> Result<Vec<u8>, DecodeError> {
        display_png_with(self.sys, self.codecs, self.gate, bytes)
    }
}

pub fn decode(bytes: &[u8], max_pixels: u64) -> Result<DecodedWithIcc, DecodeError> {
    Decoder::SYSTEM.decode(bytes, max_pixels)
}

pub fn thumbnail(bytes: &[u8], max_edge: u32) -> Result<Thumbnail, DecodeError> {
    Decoder::SYSTEM.thumbnail(bytes, max_edge)
}

/// 显示通道用：长边不超过 8000 的不压缩 PNG（带 ICC）。同时最多 2 个在算，其余等待。
pub fn display_png(bytes: &[u8]) -> Result<Vec<u8>, DecodeError> {
    Decoder::SYSTEM.display_png(bytes)
}

/// Some(true) 缺失，Some(false) 可用，None 还不知道。每次系统解码后更新。
pub fn codec_missing(kind: Kind) -> Option<bool> {
    CODECS.missing(kind)
}

pub fn reset_codec_state() {
    CODECS.reset()
}

/// 解码并转正；宽 × 高超过 max_pixels → TooLarge。
pub fn decode_with(
    sys: SysDecode,
    codecs: &CodecState,
    bytes: &[u8],
    max_pixels: u64,
) -> Result<DecodedWithIcc, DecodeError> {
    match system_kind(bytes) {
        Some(kind) => system(sys, codecs, bytes, kind, max_pixels, None).map(split),
        None => glance_imaging::decode_rgba_icc(bytes, max_pixels).map_err(imaging_err),
    }
}

/// 长边不超过 max_edge 的缩略图（有损 WebP）。
pub fn thumbnail_with(
    sys: SysDecode,
    codecs: &CodecState,
    bytes: &[u8],
    max_edge: u32,
) -> Result<Thumbnail, DecodeError> {
    let Some(kind) = system_kind(bytes) else {
        return glance_imaging::make_thumbnail(bytes, max_edge).map_err(imaging_err);
    };
    // 给了 max_edge，系统解码器直接按缩小后的尺寸出图，像素上限不起作用。
    let img = system(sys, codecs, bytes, kind, u64::MAX, Some(max_edge))?;
    let has_alpha = img.rgba.chunks_exact(4).any(|px| px[3] != 255);
    glance_imaging::thumbnail_from_rgba(split(img).decoded, has_alpha, max_edge)
        .map_err(imaging_err)
}

/// 长边不超过 [`DISPLAY_MAX_EDGE`] 的不压缩 PNG（带 ICC）。整个解码与编码都在闸门里。
pub fn display_png_with(
    sys: SysDecode,
    codecs: &CodecState,
    gate: &Gate,
    bytes: &[u8],
) -> Result<Vec<u8>, DecodeError> {
    let _permit = gate.enter();
    let d = match system_kind(bytes) {
        Some(kind) => split(system(
            sys,
            codecs,
            bytes,
            kind,
            u64::MAX,
            Some(DISPLAY_MAX_EDGE),
        )?),
        None => {
            let d = glance_imaging::decode_rgba_icc(bytes, u64::MAX).map_err(imaging_err)?;
            let view = RgbaView {
                width: d.decoded.width,
                height: d.decoded.height,
                data: &d.decoded.rgba,
            };
            DecodedWithIcc {
                decoded: glance_imaging::downscale(view, DISPLAY_MAX_EDGE).map_err(imaging_err)?,
                icc: d.icc,
            }
        }
    };
    let view = RgbaView {
        width: d.decoded.width,
        height: d.decoded.height,
        data: &d.decoded.rgba,
    };
    glance_imaging::encode_png_stored(view, d.icc.as_deref()).map_err(imaging_err)
}

/// 其他模块的测试用：永远报 NoCodec 的解码器，状态与闸门各自独立，不碰进程内那一份。
#[cfg(test)]
pub fn no_codec_decoder() -> Decoder {
    fn sys(_: &[u8], _: Kind, _: u64, _: Option<u32>) -> Result<Image, CodecError> {
        Err(CodecError::NoCodec)
    }
    Decoder {
        sys,
        codecs: Box::leak(Box::new(CodecState::new())),
        gate: Box::leak(Box::new(Gate::new(DISPLAY_CONCURRENCY))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glance_imaging::encode_png_lossless;
    use glance_imaging::heif::testkit::ftyp;
    use std::cell::RefCell;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// 替身收到的每次调用：(格式, max_pixels, max_edge)。每个测试线程一份。
    type Call = (Kind, u64, Option<u32>);
    thread_local! {
        static CALLS: RefCell<Vec<Call>> = const { RefCell::new(Vec::new()) };
    }

    fn calls() -> Vec<Call> {
        CALLS.with(|c| c.borrow().clone())
    }

    /// 2×1、带 ICC；第二个像素半透明。
    fn tiny() -> Image {
        Image {
            width: 2,
            height: 1,
            rgba: vec![10, 20, 30, 255, 40, 50, 60, 128],
            icc: Some(vec![1, 2, 3]),
        }
    }

    fn ok_sys(
        _: &[u8],
        kind: Kind,
        max_pixels: u64,
        max_edge: Option<u32>,
    ) -> Result<Image, CodecError> {
        CALLS.with(|c| c.borrow_mut().push((kind, max_pixels, max_edge)));
        Ok(tiny())
    }

    fn no_codec_sys(
        _: &[u8],
        kind: Kind,
        max_pixels: u64,
        max_edge: Option<u32>,
    ) -> Result<Image, CodecError> {
        CALLS.with(|c| c.borrow_mut().push((kind, max_pixels, max_edge)));
        Err(CodecError::NoCodec)
    }

    fn bad_sys(_: &[u8], _: Kind, _: u64, _: Option<u32>) -> Result<Image, CodecError> {
        Err(CodecError::Decode("坏".into()))
    }

    fn too_large_sys(_: &[u8], _: Kind, _: u64, _: Option<u32>) -> Result<Image, CodecError> {
        Err(CodecError::TooLarge)
    }

    fn heic() -> Vec<u8> {
        let mut b = ftyp(b"heic", &[*b"mif1", *b"heic"]);
        b.extend_from_slice(&[0; 64]);
        b
    }

    fn avif() -> Vec<u8> {
        let mut b = ftyp(b"avif", &[*b"mif1", *b"avif"]);
        b.extend_from_slice(&[0; 64]);
        b
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let data: Vec<u8> = (0..w * h).flat_map(|i| [i as u8, 7, 9, 255]).collect();
        encode_png_lossless(
            RgbaView {
                width: w,
                height: h,
                data: &data,
            },
            None,
        )
        .unwrap()
    }

    #[test]
    fn dispatch_is_by_content_not_extension() {
        let st = CodecState::new();
        let d = decode_with(ok_sys, &st, &png(3, 2), u64::MAX).unwrap();
        assert_eq!((d.decoded.width, d.decoded.height), (3, 2));
        assert!(calls().is_empty(), "PNG 字节不该走系统解码器");

        let d = decode_with(ok_sys, &st, &heic(), 1234).unwrap();
        assert_eq!((d.decoded.width, d.decoded.height), (2, 1));
        assert_eq!(d.decoded.rgba, tiny().rgba);
        assert_eq!(d.icc, Some(vec![1, 2, 3]));
        assert_eq!(calls(), vec![(Kind::Heif, 1234, None)]);

        decode_with(ok_sys, &st, &avif(), 99).unwrap();
        assert_eq!(calls()[1], (Kind::Avif, 99, None));
        assert_eq!(calls().len(), 2);

        // 既不是 HEIF 也解不出来的字节：交给 glance-imaging，报 Decode，不调系统解码器。
        assert_eq!(
            decode_with(ok_sys, &st, b"not an image", u64::MAX).err(),
            Some(DecodeError::Decode)
        );
        assert_eq!(calls().len(), 2);
    }

    #[test]
    fn no_codec_propagates_and_is_recorded() {
        let st = CodecState::new();
        assert_eq!(
            decode_with(no_codec_sys, &st, &heic(), u64::MAX).err(),
            Some(DecodeError::NoCodec)
        );
        assert_eq!(st.missing(Kind::Heif), Some(true));
        assert_eq!(st.missing(Kind::Avif), None);
        assert_eq!(
            thumbnail_with(no_codec_sys, &st, &avif(), 320).err(),
            Some(DecodeError::NoCodec)
        );
        assert_eq!(st.missing(Kind::Avif), Some(true));
        let gate = Gate::new(2);
        assert_eq!(
            display_png_with(no_codec_sys, &st, &gate, &heic()).err(),
            Some(DecodeError::NoCodec)
        );
    }

    #[test]
    fn success_records_available() {
        let st = CodecState::new();
        assert!(decode_with(no_codec_sys, &st, &heic(), u64::MAX).is_err());
        assert_eq!(st.missing(Kind::Heif), Some(true));
        decode_with(ok_sys, &st, &heic(), u64::MAX).unwrap();
        assert_eq!(st.missing(Kind::Heif), Some(false));
        assert_eq!(st.missing(Kind::Avif), None);
        // 解不出来、太大也说明解码器在。
        let st = CodecState::new();
        assert_eq!(
            decode_with(bad_sys, &st, &avif(), u64::MAX).err(),
            Some(DecodeError::Decode)
        );
        assert_eq!(st.missing(Kind::Avif), Some(false));
        assert_eq!(
            decode_with(too_large_sys, &st, &heic(), 10).err(),
            Some(DecodeError::TooLarge)
        );
        assert_eq!(st.missing(Kind::Heif), Some(false));
        // 非 HEIF 的解码不改状态。
        let st = CodecState::new();
        decode_with(ok_sys, &st, &png(2, 2), u64::MAX).unwrap();
        assert_eq!(
            (st.missing(Kind::Heif), st.missing(Kind::Avif)),
            (None, None)
        );
    }

    #[test]
    fn reset_clears_state() {
        let st = CodecState::new();
        assert!(decode_with(no_codec_sys, &st, &heic(), u64::MAX).is_err());
        decode_with(ok_sys, &st, &avif(), u64::MAX).unwrap();
        assert_eq!(
            (st.missing(Kind::Heif), st.missing(Kind::Avif)),
            (Some(true), Some(false))
        );
        st.reset();
        assert_eq!(
            (st.missing(Kind::Heif), st.missing(Kind::Avif)),
            (None, None)
        );
    }

    #[test]
    fn non_heif_too_large_maps_to_too_large() {
        let st = CodecState::new();
        assert_eq!(
            decode_with(ok_sys, &st, &png(10, 10), 99).err(),
            Some(DecodeError::TooLarge)
        );
    }

    #[test]
    fn thumbnail_passes_max_edge() {
        let st = CodecState::new();
        let t = thumbnail_with(ok_sys, &st, &heic(), 320).unwrap();
        assert_eq!(calls(), vec![(Kind::Heif, u64::MAX, Some(320))]);
        assert_eq!((t.width, t.height), (2, 1));
        assert!(imagesize::blob_size(&t.webp).is_ok());
        // 非 HEIF 仍走 glance-imaging，不调系统解码器。
        let t = thumbnail_with(ok_sys, &st, &png(640, 320), 320).unwrap();
        assert_eq!((t.width, t.height), (320, 160));
        assert_eq!(calls().len(), 1);
        assert_eq!(
            thumbnail_with(bad_sys, &st, &heic(), 320).err(),
            Some(DecodeError::Decode)
        );
    }

    #[test]
    fn display_png_caps_edge_at_8000() {
        let st = CodecState::new();
        let gate = Gate::new(2);
        let out = display_png_with(ok_sys, &st, &gate, &heic()).unwrap();
        assert_eq!(calls(), vec![(Kind::Heif, u64::MAX, Some(8000))]);
        assert!(out.starts_with(b"\x89PNG"));
        let back = glance_imaging::decode_rgba_icc(&out, u64::MAX).unwrap();
        assert_eq!((back.decoded.width, back.decoded.height), (2, 1));
        assert_eq!(back.decoded.rgba, tiny().rgba);
        assert_eq!(back.icc, Some(vec![1, 2, 3]));
    }

    static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
    static MAX_SEEN: AtomicUsize = AtomicUsize::new(0);

    fn slow_sys(_: &[u8], _: Kind, _: u64, _: Option<u32>) -> Result<Image, CodecError> {
        let now = IN_FLIGHT.fetch_add(1, Ordering::SeqCst) + 1;
        MAX_SEEN.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(40));
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        Ok(tiny())
    }

    #[test]
    fn display_concurrency_is_2() {
        let st = CodecState::new();
        let gate = Gate::new(DISPLAY_CONCURRENCY);
        let bytes = heic();
        std::thread::scope(|s| {
            for _ in 0..6 {
                s.spawn(|| display_png_with(slow_sys, &st, &gate, &bytes).unwrap());
            }
        });
        assert_eq!(MAX_SEEN.load(Ordering::SeqCst), 2);
    }

    fn panicking_sys(_: &[u8], _: Kind, _: u64, _: Option<u32>) -> Result<Image, CodecError> {
        panic!("替身 panic");
    }

    #[test]
    fn display_permit_is_released_on_panic() {
        let st = CodecState::new();
        let gate = Gate::new(1);
        let bytes = heic();
        for _ in 0..3 {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                display_png_with(panicking_sys, &st, &gate, &bytes)
            }));
            assert!(r.is_err());
        }
        // 名额若没还，这里会永远等下去：放到独立线程里限时等结果。
        let gate: &'static Gate = Box::leak(Box::new(gate));
        let st: &'static CodecState = Box::leak(Box::new(st));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(display_png_with(ok_sys, st, gate, &heic()).is_ok());
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(true));
    }
}
