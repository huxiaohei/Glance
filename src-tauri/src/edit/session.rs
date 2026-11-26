//! 编辑会话：至多一个；持有原图与代理图的 RGBA、ICC、源格式，以及最近一份代理结果与全尺寸结果。

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

use glance_imaging::{
    Decoded, EditParams, Encoded, ImagingError, OutFormat, RemoveBg, RgbaView, SrcFormat, apply,
    decode_rgba_icc, downscale, encode_jpeg, encode_png_fast, out_dims, pick, remove_bg,
    src_format_of,
};
use serde::Serialize;

use super::worker::{Answer, Request, Worker};
use crate::catalog::details::image_details;
use crate::catalog::registry::{FileId, Registry};

/// 编辑解码的像素上限。
pub const MAX_PIXELS: u64 = 100_000_000;
/// 代理图长边上限。
pub const PROXY_EDGE: u32 = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditError {
    NotFound,
    Animated,
    TooLarge,
    Decode,
    Unsupported,
    NoSession,
    Encode,
    /// 参数不合法（区域越界、取色位置超出图片等）。
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOpened {
    pub session: u32,
    pub width: u32,
    pub height: u32,
    pub proxy_w: u32,
    pub proxy_h: u32,
    pub src_format: SrcFormat,
    pub has_alpha: bool,
    pub file_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub rev: u32,
    pub bytes: u64,
    pub approx: bool,
    pub format: OutFormat,
    pub width: u32,
    pub height: u32,
}

impl From<ImagingError> for EditError {
    fn from(e: ImagingError) -> Self {
        match e {
            ImagingError::TooLarge => EditError::TooLarge,
            ImagingError::Decode(_) => EditError::Decode,
            ImagingError::Unsupported => EditError::Unsupported,
            ImagingError::InvalidParams(_) => EditError::Invalid,
            _ => EditError::Encode,
        }
    }
}

fn mime_of(f: OutFormat) -> &'static str {
    match f {
        OutFormat::Png => "image/png",
        OutFormat::Jpeg => "image/jpeg",
        OutFormat::Webp => "image/webp",
    }
}

fn view(d: &Decoded) -> RgbaView<'_> {
    RgbaView {
        width: d.width,
        height: d.height,
        data: &d.rgba,
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 输出格式：转格式取目标格式，压缩取源格式（GIF / BMP 不支持压缩）。
fn out_format(src: SrcFormat, p: &EditParams) -> Result<OutFormat, EditError> {
    match *p {
        EditParams::Convert { format, .. } => Ok(format),
        EditParams::Compress { .. } => match src {
            SrcFormat::Png => Ok(OutFormat::Png),
            SrcFormat::Jpeg => Ok(OutFormat::Jpeg),
            SrcFormat::Webp => Ok(OutFormat::Webp),
            SrcFormat::Gif | SrcFormat::Bmp => Err(EditError::Unsupported),
        },
        EditParams::RemoveBg(_) => Ok(OutFormat::Png),
        EditParams::Crop { .. } => match src {
            SrcFormat::Jpeg => Ok(OutFormat::Jpeg),
            SrcFormat::Webp => Ok(OutFormat::Webp),
            SrcFormat::Png | SrcFormat::Gif | SrcFormat::Bmp => Ok(OutFormat::Png),
        },
    }
}

/// 拖动中预览所用图的长边上限：PNG 编码慢，用更小的图。
fn drag_edge(f: OutFormat) -> u32 {
    match f {
        OutFormat::Png => 512,
        OutFormat::Jpeg | OutFormat::Webp => 1024,
    }
}

/// 在缩小的图上算时，把“限制最长边”按 (所用长边 / 原长边) 换算，四舍五入且不小于 1。
fn scale_params(p: &EditParams, used_long: u32, orig_long: u32) -> EditParams {
    match *p {
        EditParams::Compress {
            quality,
            max_edge: Some(m),
            png_mode,
        } if used_long < orig_long => {
            let m = (u64::from(m) * u64::from(used_long) + u64::from(orig_long) / 2)
                / u64::from(orig_long);
            EditParams::Compress {
                quality,
                max_edge: Some(m.clamp(1, u64::from(u32::MAX)) as u32),
                png_mode,
            }
        }
        _ => p.clone(),
    }
}

/// 一次计算的产物，提交时记入会话。
pub(crate) enum Computed {
    Proxy {
        enc: Encoded,
        bytes: u64,
        width: u32,
        height: u32,
    },
    Full {
        enc: Arc<Encoded>,
    },
}

/// 结果字节用 `Arc` 共享：协议应答与保存都不复制整块编码结果。
#[derive(Default)]
struct Results {
    /// 最近提交的版本号，只进不退；`bytes` 只认它。
    latest: Option<u32>,
    proxy: Option<(u32, Arc<Encoded>)>,
    full: Option<(u32, Arc<Encoded>)>,
}

/// 全尺寸结果的缓存与进行中的计算：同参数的计算只做一次，后来者等它。
#[derive(Default)]
struct FullCache {
    /// 最近算好的一份（不论是否提交），保存与同参数的请求复用。
    last: Option<(EditParams, Arc<Encoded>)>,
    /// 正在算的参数。
    inflight: Vec<EditParams>,
}

pub(crate) struct Session {
    id: u32,
    /// 打开时的源图。
    source: FileId,
    src_format: SrcFormat,
    icc: Option<Vec<u8>>,
    orig: Arc<Decoded>,
    proxy: Arc<Decoded>,
    /// 原图是否有半透明或透明像素（“按透明度去背景”只对它有意义）。
    has_alpha: bool,
    /// 代理图编码后的字节（给前端当画布底图），首次请求时编码。
    source_cache: OnceLock<(Arc<Vec<u8>>, &'static str)>,
    /// 拖动预览用的更小代理图，按长边上限各算一次。
    drag: Mutex<Vec<(u32, Arc<Decoded>)>>,
    results: Mutex<Results>,
    full_cache: Mutex<FullCache>,
    full_done: Condvar,
    /// 两条通道各一条线程、各自只留最新请求：代理请求不排在耗时的全尺寸计算后面。
    proxy_lane: Worker,
    full_lane: Worker,
    #[cfg(test)]
    full_computes: AtomicU32,
    /// 测试用：下一次全尺寸计算开始时调用一次（拦住计算）。
    #[cfg(test)]
    full_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Session {
    fn icc(&self) -> Option<&[u8]> {
        self.icc.as_deref()
    }

    fn drag_proxy(&self, edge: u32) -> Result<Arc<Decoded>, EditError> {
        if self.proxy.width.max(self.proxy.height) <= edge {
            return Ok(self.proxy.clone());
        }
        let mut drag = lock(&self.drag);
        if let Some((_, d)) = drag.iter().find(|(e, _)| *e == edge) {
            return Ok(d.clone());
        }
        let d = Arc::new(downscale(view(&self.proxy), edge)?);
        drag.push((edge, d.clone()));
        Ok(d)
    }

    #[cfg(test)]
    fn cached_full(&self, params: &EditParams) -> Option<Arc<Encoded>> {
        lock(&self.full_cache)
            .last
            .as_ref()
            .filter(|(p, _)| p == params)
            .map(|(_, e)| e.clone())
    }

    /// 参数与这张图不相容时的统一闸门：不透明的图没有可按透明度去除的像素。
    /// 预览（两条通道）与保存都经过 `approx` 或 `full`，都从这里过。
    fn gate(&self, params: &EditParams) -> Result<(), EditError> {
        if matches!(params, EditParams::RemoveBg(RemoveBg::Alpha { .. })) && !self.has_alpha {
            return Err(EditError::Unsupported);
        }
        Ok(())
    }

    /// 代理图（已转正、长边 ≤2048）的编码：有透明用快速 PNG，否则 JPEG q90。
    fn source_image(&self) -> Option<(Arc<Vec<u8>>, &'static str)> {
        if let Some(c) = self.source_cache.get() {
            return Some(c.clone());
        }
        let v = view(&self.proxy);
        let made = if self.has_alpha {
            encode_png_fast(v).map(|b| (b, "image/png"))
        } else {
            encode_jpeg(v, 90, [255; 3], None).map(|b| (b, "image/jpeg"))
        }
        .ok()?;
        Some(
            self.source_cache
                .get_or_init(|| (Arc::new(made.0), made.1))
                .clone(),
        )
    }

    /// 全尺寸结果：参数与最近一份相同则复用；同参数正在算（全尺寸通道或另一次保存）则等它算完；
    /// 否则在调用方线程上算。
    fn full(&self, params: &EditParams) -> Result<Arc<Encoded>, EditError> {
        self.gate(params)?;
        let mut cache = lock(&self.full_cache);
        loop {
            if let Some((_, e)) = cache.last.as_ref().filter(|(p, _)| p == params) {
                return Ok(e.clone());
            }
            if !cache.inflight.contains(params) {
                break;
            }
            cache = self
                .full_done
                .wait(cache)
                .unwrap_or_else(|e| e.into_inner());
        }
        cache.inflight.push(params.clone());
        drop(cache);
        #[cfg(test)]
        {
            self.full_computes.fetch_add(1, Ordering::Relaxed);
            let hook = lock(&self.full_hook).take();
            if let Some(h) = hook {
                h();
            }
        }
        let out = std::panic::catch_unwind(AssertUnwindSafe(|| {
            apply(view(&self.orig), self.src_format, self.icc(), params)
        }));
        let mut cache = lock(&self.full_cache);
        if let Some(i) = cache.inflight.iter().position(|p| p == params) {
            cache.inflight.swap_remove(i);
        }
        let out = match out {
            Ok(Ok(enc)) => {
                let enc = Arc::new(enc);
                cache.last = Some((params.clone(), enc.clone()));
                Ok(enc)
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(EditError::Encode),
        };
        // 失败时等待方醒来后找不到结果、也不在算，会自己再算一次。
        self.full_done.notify_all();
        out
    }

    /// 在缩小的代理图上算，体积按像素比例换算到全尺寸输出。
    fn approx(&self, params: &EditParams) -> Result<Computed, EditError> {
        self.gate(params)?;
        let fmt = out_format(self.src_format, params)?;
        // 裁剪没有代理预览：前端用画布叠框，不发这种请求。
        if matches!(params, EditParams::Crop { .. }) {
            return Err(EditError::Unsupported);
        }
        let edge = match params {
            EditParams::RemoveBg(_) => 1024,
            _ => drag_edge(fmt),
        };
        let src = self.drag_proxy(edge)?;
        let orig_long = self.orig.width.max(self.orig.height);
        let p = scale_params(params, src.width.max(src.height), orig_long);
        let enc = match &p {
            // 去背景预览只要抠得对：不带 ICC，用快速 PNG 编码。
            EditParams::RemoveBg(rb) => {
                let out = remove_bg(view(&src), rb)?;
                let bytes = encode_png_fast(RgbaView {
                    width: src.width,
                    height: src.height,
                    data: &out,
                })?;
                Encoded {
                    bytes,
                    format: OutFormat::Png,
                    width: src.width,
                    height: src.height,
                }
            }
            _ => apply(view(&src), self.src_format, self.icc(), &p)?,
        };
        let (width, height) = out_dims(self.orig.width, self.orig.height, params);
        // ICC 是固定开销，不随像素数放大（WebP 输出不带 ICC）。
        let fixed = match fmt {
            OutFormat::Webp => 0,
            _ => self.icc.as_ref().map_or(0, Vec::len),
        }
        .min(enc.bytes.len()) as f64;
        let ratio =
            f64::from(width) * f64::from(height) / (f64::from(enc.width) * f64::from(enc.height));
        let bytes = ((enc.bytes.len() as f64 - fixed) * ratio + fixed).round() as u64;
        Ok(Computed::Proxy {
            enc,
            bytes,
            width,
            height,
        })
    }

    fn compute(&self, req: &Request) -> Result<Computed, EditError> {
        if req.full {
            Ok(Computed::Full {
                enc: self.full(&req.params)?,
            })
        } else {
            self.approx(&req.params)
        }
    }

    /// 记下结果。两条通道共用 `latest`，只进不退：比已提交的版本号小（另一条通道已提交了更新的）时
    /// 不记、返回 `None`；相同版本号可以记（同一版本的全尺寸结果替下代理结果）。
    fn commit(&self, rev: u32, c: Computed) -> Option<PreviewResult> {
        let mut r = lock(&self.results);
        if r.latest.is_some_and(|l| rev < l) {
            return None;
        }
        r.latest = Some(rev);
        Some(match c {
            Computed::Proxy {
                enc,
                bytes,
                width,
                height,
            } => {
                let out = PreviewResult {
                    rev,
                    bytes,
                    approx: true,
                    format: enc.format,
                    width,
                    height,
                };
                r.proxy = Some((rev, Arc::new(enc)));
                out
            }
            Computed::Full { enc } => {
                let out = PreviewResult {
                    rev,
                    bytes: enc.bytes.len() as u64,
                    approx: false,
                    format: enc.format,
                    width: enc.width,
                    height: enc.height,
                };
                r.full = Some((rev, enc));
                out
            }
        })
    }

    fn lane(&self, full: bool) -> &Worker {
        if full {
            &self.full_lane
        } else {
            &self.proxy_lane
        }
    }

    fn close_lanes(&self) {
        self.proxy_lane.close();
        self.full_lane.close();
    }

    fn bytes(&self, rev: u32) -> Option<(Arc<Encoded>, &'static str)> {
        let r = lock(&self.results);
        if r.latest != Some(rev) {
            return None;
        }
        let enc = match (&r.full, &r.proxy) {
            (Some((fr, e)), _) if *fr == rev => e,
            (_, Some((pr, e))) if *pr == rev => e,
            _ => return None,
        };
        Some((enc.clone(), mime_of(enc.format)))
    }
}

/// 解码好的源图。读文件、解码，不上主线程。
struct Loaded {
    src_format: SrcFormat,
    icc: Option<Vec<u8>>,
    orig: Arc<Decoded>,
    proxy: Arc<Decoded>,
    file_size: u64,
    has_alpha: bool,
}

fn load(registry: &Registry, id: FileId) -> Result<Loaded, EditError> {
    let path = registry.path(id).ok_or(EditError::NotFound)?;
    let details = image_details(&path).ok_or(EditError::NotFound)?;
    if details.animated {
        return Err(EditError::Animated);
    }
    let bytes = std::fs::read(&path).map_err(|_| EditError::NotFound)?;
    let src_format = src_format_of(&bytes).ok_or(EditError::Unsupported)?;
    let d = decode_rgba_icc(&bytes, MAX_PIXELS)?;
    let orig = Arc::new(d.decoded);
    let proxy = if orig.width.max(orig.height) <= PROXY_EDGE {
        orig.clone()
    } else {
        Arc::new(downscale(view(&orig), PROXY_EDGE)?)
    };
    let has_alpha = orig.rgba.chunks_exact(4).any(|p| p[3] != 255);
    Ok(Loaded {
        src_format,
        icc: d.icc,
        orig,
        proxy,
        file_size: bytes.len() as u64,
        has_alpha,
    })
}

/// 至多一个编辑会话；会话号自增。
#[derive(Default)]
pub struct EditState {
    current: Mutex<Option<Arc<Session>>>,
    next: AtomicU32,
}

impl EditState {
    fn session(&self, id: u32) -> Result<Arc<Session>, EditError> {
        lock(&self.current)
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or(EditError::NoSession)
    }

    fn take_current(&self) {
        if let Some(old) = lock(&self.current).take() {
            old.close_lanes();
        }
    }

    /// 打开编辑会话：先关旧会话，再读文件、解码、建代理图并起预览线程。动图不建会话。
    /// 读文件与解码在调用方线程上做，调用方不得是主线程。
    pub fn open(&self, registry: &Registry, id: FileId) -> Result<EditOpened, EditError> {
        self.take_current();
        let l = load(registry, id)?;
        let sid = self.next.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let session = Arc::new(Session {
            id: sid,
            source: id,
            src_format: l.src_format,
            icc: l.icc,
            orig: l.orig,
            proxy: l.proxy,
            has_alpha: l.has_alpha,
            source_cache: OnceLock::new(),
            drag: Mutex::default(),
            results: Mutex::default(),
            full_cache: Mutex::default(),
            full_done: Condvar::new(),
            proxy_lane: Worker::default(),
            full_lane: Worker::default(),
            #[cfg(test)]
            full_computes: AtomicU32::new(0),
            #[cfg(test)]
            full_hook: Mutex::default(),
        });
        for full in [false, true] {
            let s = session.clone();
            let spawned = std::thread::Builder::new()
                .name(format!(
                    "glance-edit-{sid}-{}",
                    if full { "full" } else { "proxy" }
                ))
                .spawn(move || {
                    s.lane(full)
                        .run(|req| s.compute(req), |rev, c| s.commit(rev, c))
                });
            if spawned.is_err() {
                session.close_lanes();
                return Err(EditError::Encode);
            }
        }
        let opened = EditOpened {
            session: sid,
            width: session.orig.width,
            height: session.orig.height,
            proxy_w: session.proxy.width,
            proxy_h: session.proxy.height,
            src_format: session.src_format,
            has_alpha: l.has_alpha,
            file_size: l.file_size,
        };
        // 并发打开时后到的为准，被替下的会话关闭。
        if let Some(old) = lock(&self.current).replace(session) {
            old.close_lanes();
        }
        Ok(opened)
    }

    /// 把预览请求放进当前会话的槽，返回应答通道；不阻塞。
    pub fn submit(
        &self,
        session: u32,
        rev: u32,
        params: EditParams,
        full: bool,
    ) -> Result<Receiver<Answer>, EditError> {
        let s = self.session(session)?;
        let (req, rx) = Request::new(rev, params, full);
        s.lane(full).submit(req);
        Ok(rx)
    }

    /// 同 [`submit`](Self::submit)，并阻塞等到应答。调用方不得是主线程或异步运行时的工作线程。
    #[cfg(test)]
    pub fn preview(&self, session: u32, rev: u32, params: EditParams, full: bool) -> Answer {
        let rx = self.submit(session, rev, params, full)?;
        rx.recv().unwrap_or(Ok(None))
    }

    /// 只关闭会话号相符的当前会话。
    pub fn close(&self, session: u32) {
        let mut cur = lock(&self.current);
        if cur.as_ref().is_some_and(|s| s.id == session)
            && let Some(old) = cur.take()
        {
            old.close_lanes();
        }
    }

    /// 当前会话最近一次提交的结果（共享，不复制）与 MIME；会话或版本不符为 None（协议 404）。
    pub fn bytes(&self, session: u32, rev: u32) -> Option<(Arc<Encoded>, &'static str)> {
        self.session(session).ok()?.bytes(rev)
    }

    /// 会话的源图与它的格式。
    pub fn source(&self, session: u32) -> Result<(FileId, SrcFormat), EditError> {
        let s = self.session(session)?;
        Ok((s.source, s.src_format))
    }

    /// 会话代理图的编码字节与 MIME；会话不符为 None（协议 404）。
    pub fn source_image(&self, session: u32) -> Option<(Arc<Vec<u8>>, &'static str)> {
        self.session(session).ok()?.source_image()
    }

    /// 在转正后的原图上取色。坐标为全尺寸像素；越界为 `Invalid`。
    pub fn pick(&self, session: u32, x: u32, y: u32) -> Result<[u8; 3], EditError> {
        let s = self.session(session)?;
        Ok(pick(view(&s.orig), x, y)?)
    }

    /// 最近一份全尺寸结果，参数相同才返回。
    #[cfg(test)]
    fn full_result_for(&self, session: u32, params: &EditParams) -> Option<Arc<Encoded>> {
        self.session(session).ok()?.cached_full(params)
    }

    /// 全尺寸结果：参数相同则复用；同参数正在算（如停手后的全尺寸预览）则等它；否则在调用方线程上算
    /// （记作最近一份全尺寸结果，不提交版本）。调用方不得是主线程。
    pub fn compute_full(
        &self,
        session: u32,
        params: &EditParams,
    ) -> Result<Arc<Encoded>, EditError> {
        self.session(session)?.full(params)
    }

    #[cfg(test)]
    fn current_id(&self) -> Option<u32> {
        lock(&self.current).as_ref().map(|s| s.id)
    }
    #[cfg(test)]
    fn full_computes(&self) -> u32 {
        lock(&self.current)
            .as_ref()
            .map_or(0, |s| s.full_computes.load(Ordering::Relaxed))
    }
    #[cfg(test)]
    fn set_full_hook(&self, h: impl FnOnce() + Send + 'static) {
        if let Some(s) = lock(&self.current).as_ref() {
            *lock(&s.full_hook) = Some(Box::new(h));
        }
    }
    #[cfg(test)]
    fn drag_proxy_count(&self) -> usize {
        lock(&self.current)
            .as_ref()
            .map_or(0, |s| lock(&s.drag).len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::details::testimg::gif;
    use glance_imaging::{PngMode, decode_rgba, encode_png_lossless};
    use std::path::Path;

    fn png(path: &Path, w: u32, h: u32) {
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

    struct Fx {
        _dir: tempfile::TempDir,
        reg: Registry,
        a: FileId,
        b: FileId,
    }

    fn fx(w: u32, h: u32) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let (pa, pb) = (dir.path().join("a.png"), dir.path().join("b.png"));
        png(&pa, w, h);
        png(&pb, 40, 30);
        let (a, b) = (reg.register(&pa), reg.register(&pb));
        Fx {
            _dir: dir,
            reg,
            a,
            b,
        }
    }

    fn jpeg(q: u8) -> EditParams {
        EditParams::Convert {
            format: OutFormat::Jpeg,
            quality: q,
            fill: [255; 3],
        }
    }

    fn png_compress(max_edge: Option<u32>) -> EditParams {
        EditParams::Compress {
            quality: 80,
            max_edge,
            png_mode: PngMode::Lossless,
        }
    }

    #[test]
    fn open_builds_proxy_le_2048() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let o = st.open(&f.reg, f.a).unwrap();
        assert_eq!((o.width, o.height), (3000, 1000));
        assert_eq!((o.proxy_w, o.proxy_h), (2048, 683));
        assert_eq!(o.src_format, SrcFormat::Png);
        assert_eq!(st.source(o.session), Ok((f.a, SrcFormat::Png)));
        assert_eq!(st.source(o.session + 1), Err(EditError::NoSession));
        assert!(!o.has_alpha);
        let size = std::fs::metadata(f.reg.path(f.a).unwrap()).unwrap().len();
        assert_eq!(o.file_size, size);
        let json = serde_json::to_value(&o).unwrap();
        assert_eq!(json["proxyW"], 2048);
        assert_eq!(json["srcFormat"], "png");
        assert_eq!(json["hasAlpha"], false);
        assert_eq!(json["fileSize"], size);
    }

    #[test]
    fn small_image_proxy_is_itself() {
        let f = fx(300, 100);
        let o = EditState::default().open(&f.reg, f.a).unwrap();
        assert_eq!((o.proxy_w, o.proxy_h), (300, 100));
    }

    #[test]
    fn open_rejects_animated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("anim.gif");
        std::fs::write(&p, gif(2)).unwrap();
        let reg = Registry::default();
        let id = reg.register(&p);
        let st = EditState::default();
        assert_eq!(st.open(&reg, id), Err(EditError::Animated));
        assert!(st.current_id().is_none());
        // 单帧 GIF 可以编辑。
        let p1 = dir.path().join("one.gif");
        std::fs::write(&p1, gif(1)).unwrap();
        let o = st.open(&reg, reg.register(&p1)).unwrap();
        assert_eq!(o.src_format, SrcFormat::Gif);
    }

    #[test]
    fn open_errors() {
        let st = EditState::default();
        let reg = Registry::default();
        assert_eq!(st.open(&reg, FileId(99)), Err(EditError::NotFound));
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.png");
        std::fs::write(&p, b"not an image").unwrap();
        assert_eq!(st.open(&reg, reg.register(&p)), Err(EditError::Unsupported));
        let p = dir.path().join("broken.png");
        std::fs::write(&p, b"\x89PNG\r\n\x1a\nbroken").unwrap();
        assert_eq!(st.open(&reg, reg.register(&p)), Err(EditError::Decode));
        assert_eq!(
            serde_json::to_value(EditError::TooLarge).unwrap(),
            "tooLarge"
        );
        assert_eq!(
            serde_json::to_value(EditError::NoSession).unwrap(),
            "noSession"
        );
    }

    #[test]
    fn open_closes_previous() {
        let f = fx(300, 100);
        let st = EditState::default();
        let a = st.open(&f.reg, f.a).unwrap().session;
        assert!(st.preview(a, 1, jpeg(80), true).unwrap().is_some());
        let b = st.open(&f.reg, f.b).unwrap().session;
        assert_ne!(a, b);
        assert_eq!(st.current_id(), Some(b));
        assert_eq!(st.preview(a, 2, jpeg(80), true), Err(EditError::NoSession));
        assert!(st.bytes(a, 1).is_none());
        assert!(st.full_result_for(a, &jpeg(80)).is_none());
        assert_eq!(
            st.compute_full(a, &jpeg(80)).err(),
            Some(EditError::NoSession)
        );
        // 关别的会话号不影响当前会话。
        st.close(a);
        assert_eq!(st.current_id(), Some(b));
        st.close(b);
        assert_eq!(st.current_id(), None);
        assert_eq!(st.preview(b, 1, jpeg(80), true), Err(EditError::NoSession));
    }

    #[test]
    fn superseded_request_returns_none() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let (started, gate) = block_full(&st);
        let rx1 = st.submit(s, 1, jpeg(51), true).unwrap();
        started.recv().unwrap();
        let rxs: Vec<_> = (2..=5u32)
            .map(|rev| st.submit(s, rev, jpeg(50 + rev as u8), true).unwrap())
            .collect();
        gate.wait();
        // rev 1 已开始算：算完照样交出；2–4 未开始即被顶掉。
        assert_eq!(rx1.recv().unwrap().unwrap().unwrap().rev, 1);
        let answers: Vec<_> = rxs.into_iter().map(|rx| rx.recv().unwrap()).collect();
        for (i, a) in answers.iter().enumerate().take(3) {
            assert_eq!(a, &Ok(None), "rev {}", i + 2);
        }
        let last = answers[3].clone().unwrap().unwrap();
        assert_eq!(last.rev, 5);
        assert!(!last.approx);
        assert_eq!((last.width, last.height), (3000, 1000));
        assert_eq!(last.format, OutFormat::Jpeg);
        assert_eq!(st.bytes(s, 5).unwrap().0.bytes.len() as u64, last.bytes);
    }

    #[test]
    fn lower_rev_never_replaces_latest() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let rx5 = st.submit(s, 5, jpeg(80), true).unwrap();
        let rx3 = st.submit(s, 3, jpeg(70), true).unwrap();
        assert_eq!(rx3.recv().unwrap(), Ok(None));
        assert_eq!(rx5.recv().unwrap().unwrap().unwrap().rev, 5);
        assert!(st.bytes(s, 5).is_some());
        // 已提交之后再来的旧版本号也不算，latest 仍是 5。
        assert_eq!(st.preview(s, 4, jpeg(60), false), Ok(None));
        assert!(st.bytes(s, 4).is_none());
        assert!(st.bytes(s, 5).is_some());
    }

    #[test]
    fn results_are_shared_not_copied() {
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let p = jpeg(77);
        st.preview(s, 1, p.clone(), true).unwrap().unwrap();
        let a = st.full_result_for(s, &p).unwrap();
        let b = st.compute_full(s, &p).unwrap();
        let (c, _) = st.bytes(s, 1).unwrap();
        assert!(Arc::ptr_eq(&a, &b) && Arc::ptr_eq(&a, &c));
    }

    #[test]
    fn close_answers_pending_with_none() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let r1 = st.submit(s, 1, jpeg(80), true).unwrap();
        let r2 = st.submit(s, 2, jpeg(81), true).unwrap();
        st.close(s);
        assert_eq!(r1.recv().unwrap(), Ok(None));
        assert_eq!(r2.recv().unwrap(), Ok(None));
        assert!(st.bytes(s, 1).is_none() && st.bytes(s, 2).is_none());
    }

    #[test]
    fn stale_rev_is_404() {
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        st.preview(s, 1, jpeg(80), false).unwrap().unwrap();
        assert_eq!(st.bytes(s, 1).unwrap().1, "image/jpeg");
        st.preview(s, 2, png_compress(None), false)
            .unwrap()
            .unwrap();
        assert!(st.bytes(s, 1).is_none());
        let (b, mime) = st.bytes(s, 2).unwrap();
        assert_eq!(mime, "image/png");
        assert!(b.bytes.starts_with(b"\x89PNG"));
        assert!(st.bytes(s + 1, 2).is_none());
        // 全尺寸结果也只认最新版本。
        st.preview(s, 3, jpeg(70), true).unwrap().unwrap();
        assert!(st.bytes(s, 2).is_none());
        assert!(st.bytes(s, 3).is_some());
        st.preview(s, 4, jpeg(60), false).unwrap().unwrap();
        assert!(st.bytes(s, 3).is_none());
        assert!(st.bytes(s, 4).is_some());
    }

    #[test]
    fn full_result_reused_when_params_equal() {
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let p = jpeg(77);
        let r1 = st.preview(s, 1, p.clone(), true).unwrap().unwrap();
        assert_eq!(st.full_computes(), 1);
        let cached = st.full_result_for(s, &p).unwrap();
        assert_eq!(cached.bytes.len() as u64, r1.bytes);
        assert!(st.full_result_for(s, &jpeg(78)).is_none());
        // 同参数的全尺寸请求与保存都直接复用，不再计算。
        let r2 = st.preview(s, 2, p.clone(), true).unwrap().unwrap();
        assert_eq!((r2.rev, r2.bytes), (2, r1.bytes));
        assert_eq!(st.compute_full(s, &p).unwrap().bytes, cached.bytes);
        assert_eq!(st.full_computes(), 1);
        // 代理请求不冲掉全尺寸结果。
        st.preview(s, 3, jpeg(10), false).unwrap().unwrap();
        assert!(st.full_result_for(s, &p).is_some());
        // 参数不同才重算。
        let other = st.compute_full(s, &jpeg(20)).unwrap();
        assert_eq!(other.format, OutFormat::Jpeg);
        assert_eq!(st.full_computes(), 2);
    }

    /// 拦住下一次全尺寸计算：返回“已开始”信号与放行闸门。
    fn block_full(st: &EditState) -> (Receiver<()>, Arc<std::sync::Barrier>) {
        let gate = Arc::new(std::sync::Barrier::new(2));
        let (tx, started) = std::sync::mpsc::channel();
        let g = gate.clone();
        st.set_full_hook(move || {
            tx.send(()).unwrap();
            g.wait();
        });
        (started, gate)
    }

    #[test]
    fn proxy_answered_while_full_running() {
        let f = fx(300, 100);
        let st = Arc::new(EditState::default());
        let s = st.open(&f.reg, f.a).unwrap().session;
        let (started, gate) = block_full(&st);
        let rx1 = st.submit(s, 1, jpeg(80), true).unwrap();
        started.recv().unwrap();
        // 全尺寸还在算：代理请求照样有应答。
        let rx2 = st.submit(s, 2, jpeg(60), false).unwrap();
        let r2 = rx2.recv_timeout(std::time::Duration::from_secs(5));
        gate.wait();
        let r2 = r2.expect("代理请求排在全尺寸后面").unwrap().unwrap();
        assert_eq!(r2.rev, 2);
        assert!(r2.approx);
        // 全尺寸 rev 1 比已提交的代理 rev 2 旧：不提交，地址只认 rev 2。
        assert_eq!(rx1.recv().unwrap(), Ok(None));
        assert!(st.bytes(s, 1).is_none());
        assert!(st.bytes(s, 2).is_some());
    }

    #[test]
    fn save_waits_for_inflight_full() {
        let f = fx(300, 100);
        let st = Arc::new(EditState::default());
        let s = st.open(&f.reg, f.a).unwrap().session;
        let p = jpeg(77);
        let (started, gate) = block_full(&st);
        let rx1 = st.submit(s, 1, p.clone(), true).unwrap();
        started.recv().unwrap();
        // 同参数的保存：等进行中的那次，不另算。
        let saver = {
            let (st, p) = (st.clone(), p.clone());
            std::thread::spawn(move || st.compute_full(s, &p).unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        gate.wait();
        let saved = saver.join().unwrap();
        let r1 = rx1.recv().unwrap().unwrap().unwrap();
        assert_eq!(saved.bytes.len() as u64, r1.bytes);
        assert_eq!(st.full_computes(), 1);
        assert!(Arc::ptr_eq(&saved, &st.bytes(s, 1).unwrap().0));
    }

    #[test]
    fn approx_bytes_scaled() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;

        // JPEG / WebP：在长边 1024 的代理上算。
        let r = st.preview(s, 1, jpeg(85), false).unwrap().unwrap();
        assert!(r.approx);
        assert_eq!((r.width, r.height), (3000, 1000));
        let (b, _) = st.bytes(s, 1).unwrap();
        let d = decode_rgba(&b.bytes, u64::MAX).unwrap();
        // 由 2048×683 的代理再缩：1024×342。
        assert_eq!((d.width, d.height), (1024, 342));
        let want = (b.bytes.len() as f64 * 3000.0 * 1000.0 / (1024.0 * 342.0)).round() as u64;
        assert_eq!(r.bytes, want);

        // PNG：在长边 512 的代理上算；限制最长边按比例换算，尺寸报全尺寸下的输出。
        let r = st
            .preview(s, 2, png_compress(Some(1500)), false)
            .unwrap()
            .unwrap();
        assert!(r.approx);
        assert_eq!((r.width, r.height), (1500, 500));
        let (b, _) = st.bytes(s, 2).unwrap();
        let d = decode_rgba(&b.bytes, u64::MAX).unwrap();
        // 代理 512×171，限制最长边 1500 × 512 / 3000 = 256 → 256×86。
        assert_eq!((d.width, d.height), (256, 86));
        let want = (b.bytes.len() as f64 * 1500.0 * 500.0 / (256.0 * 86.0)).round() as u64;
        assert_eq!(r.bytes, want);

        // 全尺寸：精确值。
        let r = st
            .preview(s, 3, png_compress(Some(1500)), true)
            .unwrap()
            .unwrap();
        assert!(!r.approx);
        assert_eq!((r.width, r.height), (1500, 500));
        assert_eq!(r.bytes, st.bytes(s, 3).unwrap().0.bytes.len() as u64);
    }

    #[test]
    fn drag_proxies_are_cached() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        for rev in 1..=3 {
            st.preview(s, rev, jpeg(80), false).unwrap().unwrap();
        }
        st.preview(s, 4, png_compress(None), false)
            .unwrap()
            .unwrap();
        st.preview(s, 5, png_compress(None), false)
            .unwrap()
            .unwrap();
        assert_eq!(st.drag_proxy_count(), 2);
    }

    #[test]
    fn compress_gif_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("one.gif");
        std::fs::write(&p, gif(1)).unwrap();
        let reg = Registry::default();
        let st = EditState::default();
        let s = st.open(&reg, reg.register(&p)).unwrap().session;
        assert_eq!(
            st.preview(s, 1, png_compress(None), false),
            Err(EditError::Unsupported)
        );
        assert!(st.preview(s, 2, jpeg(80), false).unwrap().is_some());
    }

    // ---- V0.3-B：裁剪、去背景、取色、源图 ----

    use glance_imaging::{CropRect, RemoveBg, encode_jpeg, encode_png_fast, remove_bg};

    fn crop(w: u32, h: u32) -> EditParams {
        EditParams::Crop {
            rect: CropRect { x: 0, y: 0, w, h },
            quarter_turns: 0,
            flip_h: false,
            flip_v: false,
        }
    }

    fn rm_color() -> EditParams {
        EditParams::RemoveBg(RemoveBg::Color {
            color: [0, 0, 0],
            tolerance: 40,
            softness: 10,
            edge_connected: false,
        })
    }

    fn rm_alpha() -> EditParams {
        EditParams::RemoveBg(RemoveBg::Alpha {
            threshold: 128,
            below: true,
        })
    }

    /// 带半透明像素的 PNG：左半不透明，右半 alpha=100。
    fn alpha_png(path: &Path, w: u32, h: u32) {
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let a = if (i % w) < w / 2 { 255 } else { 100 };
                [(i % w) as u8, (i / w) as u8, 50, a]
            })
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

    /// 在 JPEG 的 SOI 之后插入一个只含“方向”标签的 EXIF 段。
    fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
        let mut seg = vec![0xFF, 0xE1, 0x00, 0x22];
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(&[0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]);
        seg.extend_from_slice(&[0x00, 0x01]);
        seg.extend_from_slice(&[
            0x01,
            0x12,
            0x00,
            0x03,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            orientation,
            0x00,
            0x00,
        ]);
        seg.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&seg);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn out_format_for_crop_and_remove_bg() {
        let c = crop(1, 1);
        assert_eq!(out_format(SrcFormat::Jpeg, &c), Ok(OutFormat::Jpeg));
        assert_eq!(out_format(SrcFormat::Webp, &c), Ok(OutFormat::Webp));
        assert_eq!(out_format(SrcFormat::Png, &c), Ok(OutFormat::Png));
        assert_eq!(out_format(SrcFormat::Gif, &c), Ok(OutFormat::Png));
        assert_eq!(out_format(SrcFormat::Bmp, &c), Ok(OutFormat::Png));
        for f in [SrcFormat::Jpeg, SrcFormat::Gif, SrcFormat::Webp] {
            assert_eq!(out_format(f, &rm_color()), Ok(OutFormat::Png));
        }
    }

    #[test]
    fn invalid_params_map_to_invalid() {
        assert_eq!(
            EditError::from(ImagingError::InvalidParams("x")),
            EditError::Invalid
        );
        assert_eq!(serde_json::to_value(EditError::Invalid).unwrap(), "invalid");
        // 区域越界：保存与全尺寸预览都报 invalid。
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        assert_eq!(
            st.preview(s, 1, crop(400, 100), true),
            Err(EditError::Invalid)
        );
        assert_eq!(
            st.compute_full(s, &crop(400, 100)).err(),
            Some(EditError::Invalid)
        );
    }

    #[test]
    fn remove_bg_proxy_preview_uses_1024_proxy_and_fast_png() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let r = st.preview(s, 1, rm_color(), false).unwrap().unwrap();
        assert!(r.approx);
        assert_eq!(r.format, OutFormat::Png);
        assert_eq!((r.width, r.height), (3000, 1000));
        let (b, mime) = st.bytes(s, 1).unwrap();
        assert_eq!(mime, "image/png");
        let d = decode_rgba(&b.bytes, u64::MAX).unwrap();
        assert_eq!((d.width, d.height), (1024, 342));
        // 对同一张 1024 代理直接调用 remove_bg 的结果。
        let sess = st.session(s).unwrap();
        let proxy = sess.drag_proxy(1024).unwrap();
        let want = remove_bg(
            view(&proxy),
            &match rm_color() {
                EditParams::RemoveBg(p) => p,
                _ => unreachable!(),
            },
        )
        .unwrap();
        assert_eq!(d.rgba, want);
        let fast = encode_png_fast(RgbaView {
            width: proxy.width,
            height: proxy.height,
            data: &want,
        })
        .unwrap();
        assert_eq!(b.bytes, fast);
        // 全尺寸：精确值。
        let r = st.preview(s, 2, rm_color(), true).unwrap().unwrap();
        assert!(!r.approx);
        assert_eq!(r.bytes, st.bytes(s, 2).unwrap().0.bytes.len() as u64);
    }

    #[test]
    fn crop_previews() {
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        assert_eq!(
            st.preview(s, 1, crop(10, 10), false),
            Err(EditError::Unsupported)
        );
        let r = st.preview(s, 2, crop(120, 40), true).unwrap().unwrap();
        assert!(!r.approx);
        assert_eq!((r.width, r.height), (120, 40));
        assert_eq!(r.format, OutFormat::Png);
        assert_eq!(r.bytes, st.bytes(s, 2).unwrap().0.bytes.len() as u64);
    }

    #[test]
    fn alpha_gate_blocks_opaque_sessions_on_every_path() {
        let (_d, _r, st, s) = {
            let dir = tempfile::tempdir().unwrap();
            let reg = Registry::default();
            let p = dir.path().join("o.png");
            png(&p, 300, 100);
            let st = EditState::default();
            let s = st.open(&reg, reg.register(&p)).unwrap().session;
            (dir, reg, st, s)
        };
        assert_eq!(
            st.preview(s, 1, rm_alpha(), false),
            Err(EditError::Unsupported)
        );
        assert_eq!(
            st.preview(s, 2, rm_alpha(), true),
            Err(EditError::Unsupported)
        );
        assert_eq!(
            st.compute_full(s, &rm_alpha()).err(),
            Some(EditError::Unsupported)
        );
        // 颜色模式不受影响。
        assert!(st.preview(s, 3, rm_color(), false).unwrap().is_some());

        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let p = dir.path().join("t.png");
        alpha_png(&p, 300, 100);
        let st = EditState::default();
        let o = st.open(&reg, reg.register(&p)).unwrap();
        assert!(o.has_alpha);
        assert!(
            st.preview(o.session, 1, rm_alpha(), false)
                .unwrap()
                .is_some()
        );
        assert!(
            st.preview(o.session, 2, rm_alpha(), true)
                .unwrap()
                .is_some()
        );
        assert!(st.compute_full(o.session, &rm_alpha()).is_ok());
    }

    #[test]
    fn pick_reads_original_pixels() {
        let f = fx(300, 100);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        // png() 的像素：[(i % w) as u8, (i / w) as u8, ((i * 7) % 251) as u8]
        let i = 5 * 300 + 17;
        assert_eq!(st.pick(s, 17, 5), Ok([17, 5, ((i * 7) % 251) as u8]));
        assert_eq!(st.pick(s, 300, 0), Err(EditError::Invalid));
        assert_eq!(st.pick(s, 0, 100), Err(EditError::Invalid));
        assert_eq!(st.pick(s + 1, 0, 0), Err(EditError::NoSession));
    }

    #[test]
    fn source_image_encodes_once_and_picks_format_by_alpha() {
        let f = fx(3000, 1000);
        let st = EditState::default();
        let s = st.open(&f.reg, f.a).unwrap().session;
        let (b, mime) = st.source_image(s).unwrap();
        assert_eq!(mime, "image/jpeg");
        let d = decode_rgba(&b, u64::MAX).unwrap();
        assert_eq!((d.width, d.height), (2048, 683));
        let (b2, _) = st.source_image(s).unwrap();
        assert!(Arc::ptr_eq(&b, &b2));
        assert!(st.source_image(s + 1).is_none());

        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let p = dir.path().join("t.png");
        alpha_png(&p, 300, 100);
        let st = EditState::default();
        let s = st.open(&reg, reg.register(&p)).unwrap().session;
        let (b, mime) = st.source_image(s).unwrap();
        assert_eq!(mime, "image/png");
        assert!(b.starts_with(b"\x89PNG"));
    }

    #[test]
    fn exif_oriented_jpeg_edits_in_display_coordinates() {
        // 40×20：左下 10×10 红，其余蓝；方向 6（顺时针 90°）后是 20×40，红块在左上。
        let mut data = vec![0u8; 40 * 20 * 4];
        for y in 0..20u32 {
            for x in 0..40u32 {
                let i = ((y * 40 + x) * 4) as usize;
                let red = x < 10 && y >= 10;
                data[i..i + 4].copy_from_slice(if red {
                    &[255, 0, 0, 255]
                } else {
                    &[0, 0, 255, 255]
                });
            }
        }
        let jpg = encode_jpeg(
            RgbaView {
                width: 40,
                height: 20,
                data: &data,
            },
            95,
            [255; 3],
            None,
        )
        .unwrap();
        let oriented = with_exif_orientation(&jpg, 6);
        let want = decode_rgba(&oriented, u64::MAX).unwrap();
        assert_eq!((want.width, want.height), (20, 40));
        let top_left = [want.rgba[0], want.rgba[1], want.rgba[2]];
        assert!(top_left[0] > 200 && top_left[2] < 60, "{top_left:?}");

        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::default();
        let p = dir.path().join("o.jpg");
        std::fs::write(&p, &oriented).unwrap();
        let st = EditState::default();
        let o = st.open(&reg, reg.register(&p)).unwrap();
        assert_eq!((o.width, o.height), (20, 40));
        let (src, _) = st.source_image(o.session).unwrap();
        let sd = decode_rgba(&src, u64::MAX).unwrap();
        assert_eq!((sd.width, sd.height), (20, 40));
        assert_eq!(st.pick(o.session, 0, 0), Ok(top_left));
        // 裁剪左上角 1×1：颜色与转正后左上角一致（JPEG 重编码有损，容差）。
        let enc = st.compute_full(o.session, &crop(1, 1)).unwrap();
        assert_eq!((enc.width, enc.height), (1, 1));
        let c = decode_rgba(&enc.bytes, u64::MAX).unwrap();
        for k in 0..3 {
            assert!(
                (i32::from(c.rgba[k]) - i32::from(top_left[k])).abs() <= 24,
                "{:?} vs {top_left:?}",
                &c.rgba[..3]
            );
        }
    }
}
