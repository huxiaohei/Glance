//! Windows：WIC（Windows Imaging Component）解码，转成 32 位非预乘 RGBA。
//!
//! HEIF / AVIF 的 WIC 解码器由商店里的“HEIF 图像扩展”“HEVC 视频扩展”“AV1 视频扩展”提供，
//! 没装时 WIC 报“找不到组件”或“不认识的格式”，映射成 [`CodecError::NoCodec`]（见 `wic_error`）。
//! 每次调用在当前线程初始化 COM，自建工厂与流，不共享可变状态，可在多个后台线程并发调用。
//!
//! 未在 Windows 上编译与运行过；方向是否已由 WIC 摆正、透明与 ICC 的表现待 E6 实测。

use std::ptr;

use ::windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use ::windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapFrameDecode, IWICBitmapSource,
    IWICColorContext, IWICImagingFactory, WICBitmapInterpolationModeFant, WICColorContextProfile,
    WICConvertBitmapSource, WICDecodeMetadataCacheOnDemand,
};
use ::windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use ::windows::core::{IUnknown, Interface};

use crate::wic_error::map_hresult;
use crate::{CodecError, Image, Kind, boxes_complete, fit_within};

/// 一帧最多看这么多个色彩上下文。
const MAX_COLOR_CONTEXTS: u32 = 16;
/// ICC 超过这个大小就当没有（正常的 ICC 只有几 KB）。
const MAX_ICC_BYTES: u32 = 4 << 20;

pub(crate) fn decode(
    bytes: &[u8],
    _kind: Kind,
    max_pixels: u64,
    max_edge: Option<u32>,
) -> Result<Image, CodecError> {
    // 绑定层把长度转成 u32 时用 unwrap，超长的输入先挡掉，免得 panic。
    if u32::try_from(bytes.len()).is_err() {
        return Err(err("文件太大"));
    }
    let _com = ComGuard::init()?;
    // SAFETY: `decode_with_com` 里创建的所有 COM 对象（工厂、借用 `bytes` 的流、解码器、帧、
    // 缩放器、格式转换器、色彩上下文）都是它的局部变量，在它返回时全部释放；它的返回值只含
    // 自有的 Vec，不含 COM 对象，也不借用 `bytes`。所以这些对象都在 `_com` 析构
    // （必要时 CoUninitialize）之前释放，流对 `bytes` 的借用也不会活过本函数。
    decode_with_com(bytes, max_pixels, max_edge)
}

fn err(msg: &str) -> CodecError {
    CodecError::Decode(msg.to_owned())
}

fn wic(e: ::windows::core::Error) -> CodecError {
    map_hresult(e.code().0)
}

/// 本次调用在当前线程上对 COM 的初始化。
///
/// `CoInitializeEx` 返回 S_OK（首次初始化）或 S_FALSE（本线程已在多线程套间）时，
/// 本次调用都增加了初始化计数，析构时调一次 `CoUninitialize` 配对；
/// 返回 RPC_E_CHANGED_MODE（本线程已是单线程套间）时计数没变，照样可用，析构时什么都不做。
struct ComGuard {
    balance: bool,
}

impl ComGuard {
    fn init() -> Result<Self, CodecError> {
        // SAFETY: 保留参数传空；与 `Drop` 里的 `CoUninitialize` 在同一线程上配对。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self { balance: true })
        } else if hr == RPC_E_CHANGED_MODE {
            Ok(Self { balance: false })
        } else {
            Err(map_hresult(hr.0))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.balance {
            // SAFETY: 与 `init` 里成功的 `CoInitializeEx` 配对，在同一线程上；
            // 调用方保证此时本次创建的 COM 对象都已释放（见 `decode` 里的说明）。
            unsafe { CoUninitialize() };
        }
    }
}

/// 在已初始化 COM 的线程上解码。所有 COM 对象都只活在本函数里。
fn decode_with_com(
    bytes: &[u8],
    max_pixels: u64,
    max_edge: Option<u32>,
) -> Result<Image, CodecError> {
    // SAFETY: 都是 WIC 的 COM 调用；传入的指针都指向本函数的局部变量或常量。
    // 流借用 `bytes`（`decode` 已确认长度放得进 u32），流和由它派生的对象都在本函数返回前释放。
    let factory: IWICImagingFactory = unsafe {
        CoCreateInstance(
            &CLSID_WICImagingFactory,
            None::<&IUnknown>,
            CLSCTX_INPROC_SERVER,
        )
    }
    .map_err(wic)?;
    // SAFETY: 同上。
    let stream = unsafe { factory.CreateStream() }.map_err(wic)?;
    // SAFETY: 同上；`bytes` 比 `stream` 及其派生对象活得久。
    unsafe { stream.InitializeFromMemory(bytes) }.map_err(wic)?;
    // 不指定厂商（空指针），让 WIC 按内容挑解码器；缺组件时在这一步报错。
    // SAFETY: 同上。
    let decoder = unsafe {
        factory.CreateDecoderFromStream(&stream, ptr::null(), WICDecodeMetadataCacheOnDemand)
    }
    .map_err(wic)?;
    if !boxes_complete(bytes) {
        // 截断的文件，系统解码器可能照样画出半张图；一律算读不出。
        return Err(err("文件不完整或已损坏"));
    }
    // SAFETY: 同上。
    let frame = unsafe { decoder.GetFrame(0) }.map_err(wic)?;
    let (w, h) = dims(&frame)?;
    if max_edge.is_none() && u64::from(w) * u64::from(h) > max_pixels {
        return Err(CodecError::TooLarge);
    }

    // 帧本身就是 IWICBitmapSource（接口继承），转换不需要 QueryInterface。
    let mut source: IWICBitmapSource = frame.clone().into();
    if let Some(edge) = max_edge {
        let (tw, th) = fit_within(w, h, edge);
        if (tw, th) != (w, h) {
            // SAFETY: 同上。
            let scaler = unsafe { factory.CreateBitmapScaler() }.map_err(wic)?;
            // SAFETY: 同上；目标宽高都 ≥ 1。
            unsafe { scaler.Initialize(&source, tw, th, WICBitmapInterpolationModeFant) }
                .map_err(wic)?;
            source = scaler.into();
        }
    }
    // 32bppRGBA 是非预乘的 RGBA8；转换只改像素格式，不做色彩空间换算。
    // SAFETY: 同上；格式 GUID 是常量。
    let rgba_source =
        unsafe { WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &source) }.map_err(wic)?;
    let (ow, oh) = dims(&rgba_source)?;
    if max_edge.is_none() && u64::from(ow) * u64::from(oh) > max_pixels {
        // 帧报的尺寸与实际输出不符时再核一次，免得超限分配。
        return Err(CodecError::TooLarge);
    }
    let rgba = copy_pixels(&rgba_source, ow, oh)?;
    // 取不到 ICC 不算失败：按 sRGB 处理。
    let icc = icc_profile(&factory, &frame);
    Ok(Image {
        width: ow,
        height: oh,
        rgba,
        icc,
    })
}

fn dims(source: &IWICBitmapSource) -> Result<(u32, u32), CodecError> {
    let (mut w, mut h) = (0u32, 0u32);
    // SAFETY: 两个输出指针指向本函数的局部变量。
    unsafe { source.GetSize(&mut w, &mut h) }.map_err(wic)?;
    if w == 0 || h == 0 {
        return Err(err("尺寸为 0"));
    }
    Ok((w, h))
}

/// 把 32bppRGBA 的 `source`（实际尺寸 `w` × `h`）整张拷进紧排缓冲。
fn copy_pixels(source: &IWICBitmapSource, w: u32, h: u32) -> Result<Vec<u8>, CodecError> {
    let stride = w.checked_mul(4).ok_or_else(|| err("尺寸超出范围"))?;
    let len = stride.checked_mul(h).ok_or_else(|| err("尺寸超出范围"))?;
    let len = usize::try_from(len).map_err(|_| err("尺寸超出范围"))?;
    let mut rgba = Vec::new();
    rgba.try_reserve_exact(len).map_err(|_| err("内存不足"))?;
    rgba.resize(len, 0);
    // SAFETY: 矩形传空表示整张图；缓冲正好 stride × h 字节，行宽 stride = w × 4 与 32bppRGBA 一致；
    // 长度已确认放得进 u32（绑定层会把它转成 u32）。
    unsafe { source.CopyPixels(ptr::null(), stride, &mut rgba) }.map_err(wic)?;
    Ok(rgba)
}

/// 帧里第一个 ICC 类型的色彩上下文的内容；没有或读不出时为 None。
fn icc_profile(factory: &IWICImagingFactory, frame: &IWICBitmapFrameDecode) -> Option<Vec<u8>> {
    let mut count = 0u32;
    // 先用空数组问个数（文档给的用法）；绑定层的切片版本给不出空指针，所以直接调虚表。
    // SAFETY: `frame` 是有效的帧接口；数组指针为空、长度为 0，输出指针指向局部变量。
    let hr = unsafe {
        (Interface::vtable(frame).GetColorContexts)(
            Interface::as_raw(frame),
            0,
            ptr::null_mut(),
            &mut count,
        )
    };
    if hr.is_err() || count == 0 {
        return None;
    }
    let count = count.min(MAX_COLOR_CONTEXTS);
    let mut contexts: Vec<Option<IWICColorContext>> = Vec::new();
    for _ in 0..count {
        // SAFETY: 工厂是有效的接口；新建的空色彩上下文交给 GetColorContexts 填写。
        contexts.push(Some(unsafe { factory.CreateColorContext() }.ok()?));
    }
    let mut actual = 0u32;
    // SAFETY: `contexts` 里是 `count` 个已创建的色彩上下文；输出指针指向局部变量。
    unsafe { frame.GetColorContexts(&mut contexts, &mut actual) }.ok()?;
    let actual = (actual as usize).min(contexts.len());
    contexts[..actual].iter().flatten().find_map(profile_bytes)
}

/// ICC 类型的色彩上下文的字节；EXIF 色彩空间类型、空的或过大的返回 None。
fn profile_bytes(ctx: &IWICColorContext) -> Option<Vec<u8>> {
    // SAFETY: `ctx` 是有效的色彩上下文。
    if unsafe { ctx.GetType() }.ok()? != WICColorContextProfile {
        return None;
    }
    let mut size = 0u32;
    // 先用空缓冲问大小；理由同 GetColorContexts。
    // SAFETY: 缓冲指针为空、长度为 0，输出指针指向局部变量。
    let hr = unsafe {
        (Interface::vtable(ctx).GetProfileBytes)(
            Interface::as_raw(ctx),
            0,
            ptr::null_mut(),
            &mut size,
        )
    };
    if hr.is_err() || size == 0 || size > MAX_ICC_BYTES {
        return None;
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(size as usize).ok()?;
    buf.resize(size as usize, 0);
    let mut got = 0u32;
    // SAFETY: 缓冲有 `size` 字节；输出指针指向局部变量。
    unsafe { ctx.GetProfileBytes(&mut buf, &mut got) }.ok()?;
    buf.truncate(got as usize);
    (!buf.is_empty()).then_some(buf)
}
