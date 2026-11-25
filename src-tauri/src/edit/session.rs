//! 编辑会话：至多一个；持有原图与代理图的 RGBA、ICC、源格式，以及最近一份代理结果与全尺寸结果。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard};

use glance_imaging::{
    Decoded, EditParams, Encoded, ImagingError, OutFormat, RgbaView, SrcFormat, apply,
    decode_rgba_icc, downscale, out_dims, src_format_of,
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
        params: EditParams,
        enc: Encoded,
    },
}

#[derive(Default)]
struct Results {
    /// 最近提交的版本号；`bytes` 只认它。
    latest: Option<u32>,
    proxy: Option<(u32, Encoded)>,
    full: Option<(u32, EditParams, Encoded)>,
}

pub(crate) struct Session {
    id: u32,
    src_format: SrcFormat,
    icc: Option<Vec<u8>>,
    orig: Arc<Decoded>,
    proxy: Arc<Decoded>,
    /// 拖动预览用的更小代理图，按长边上限各算一次。
    drag: Mutex<Vec<(u32, Arc<Decoded>)>>,
    results: Mutex<Results>,
    worker: Worker,
    #[cfg(test)]
    full_computes: AtomicU32,
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

    fn cached_full(&self, params: &EditParams) -> Option<Encoded> {
        let r = lock(&self.results);
        r.full
            .as_ref()
            .filter(|(_, p, _)| p == params)
            .map(|(_, _, e)| e.clone())
    }

    /// 全尺寸结果：参数与最近一份相同则复用，否则在原图上算（在调用方线程上）。
    fn full(&self, params: &EditParams) -> Result<Encoded, EditError> {
        if let Some(e) = self.cached_full(params) {
            return Ok(e);
        }
        #[cfg(test)]
        self.full_computes.fetch_add(1, Ordering::Relaxed);
        Ok(apply(
            view(&self.orig),
            self.src_format,
            self.icc(),
            params,
        )?)
    }

    /// 在缩小的代理图上算，体积按像素比例换算到全尺寸输出。
    fn approx(&self, params: &EditParams) -> Result<Computed, EditError> {
        let fmt = out_format(self.src_format, params)?;
        let src = self.drag_proxy(drag_edge(fmt))?;
        let orig_long = self.orig.width.max(self.orig.height);
        let p = scale_params(params, src.width.max(src.height), orig_long);
        let enc = apply(view(&src), self.src_format, self.icc(), &p)?;
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
                params: req.params.clone(),
                enc: self.full(&req.params)?,
            })
        } else {
            self.approx(&req.params)
        }
    }

    fn commit(&self, rev: u32, c: Computed) -> PreviewResult {
        let mut r = lock(&self.results);
        r.latest = Some(rev);
        match c {
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
                r.proxy = Some((rev, enc));
                out
            }
            Computed::Full { params, enc } => {
                let out = PreviewResult {
                    rev,
                    bytes: enc.bytes.len() as u64,
                    approx: false,
                    format: enc.format,
                    width: enc.width,
                    height: enc.height,
                };
                r.full = Some((rev, params, enc));
                out
            }
        }
    }

    fn bytes(&self, rev: u32) -> Option<(Vec<u8>, &'static str)> {
        let r = lock(&self.results);
        if r.latest != Some(rev) {
            return None;
        }
        let enc = match (&r.full, &r.proxy) {
            (Some((fr, _, e)), _) if *fr == rev => e,
            (_, Some((pr, e))) if *pr == rev => e,
            _ => return None,
        };
        Some((enc.bytes.clone(), mime_of(enc.format)))
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
            old.worker.close();
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
            src_format: l.src_format,
            icc: l.icc,
            orig: l.orig,
            proxy: l.proxy,
            drag: Mutex::default(),
            results: Mutex::default(),
            worker: Worker::default(),
            #[cfg(test)]
            full_computes: AtomicU32::new(0),
        });
        let s = session.clone();
        std::thread::Builder::new()
            .name(format!("glance-edit-{sid}"))
            .spawn(move || {
                s.worker
                    .run(|req| s.compute(req), |rev, c| s.commit(rev, c))
            })
            .map_err(|_| EditError::Encode)?;
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
            old.worker.close();
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
        s.worker.submit(req);
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
            old.worker.close();
        }
    }

    /// 当前会话最近一次提交的结果的字节与 MIME；会话或版本不符为 None（协议 404）。
    pub fn bytes(&self, session: u32, rev: u32) -> Option<(Vec<u8>, &'static str)> {
        self.session(session).ok()?.bytes(rev)
    }

    /// 最近一份全尺寸结果，参数相同才返回。
    #[allow(dead_code, reason = "保存命令使用")]
    pub fn full_result_for(&self, session: u32, params: &EditParams) -> Option<Encoded> {
        self.session(session).ok()?.cached_full(params)
    }

    /// 全尺寸结果：参数相同则复用，否则在调用方线程上算（不记入会话）。
    #[allow(dead_code, reason = "保存命令使用")]
    pub fn compute_full(&self, session: u32, params: &EditParams) -> Result<Encoded, EditError> {
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
        let rxs: Vec<_> = (1..=5u32)
            .map(|rev| st.submit(s, rev, jpeg(50 + rev as u8), true).unwrap())
            .collect();
        let answers: Vec<_> = rxs.into_iter().map(|rx| rx.recv().unwrap()).collect();
        for (i, a) in answers.iter().enumerate().take(4) {
            assert_eq!(a, &Ok(None), "rev {}", i + 1);
        }
        let last = answers[4].clone().unwrap().unwrap();
        assert_eq!(last.rev, 5);
        assert!(!last.approx);
        assert_eq!((last.width, last.height), (3000, 1000));
        assert_eq!(last.format, OutFormat::Jpeg);
        assert_eq!(st.bytes(s, 5).unwrap().0.len() as u64, last.bytes);
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
        assert!(b.starts_with(b"\x89PNG"));
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
        let d = decode_rgba(&b, u64::MAX).unwrap();
        // 由 2048×683 的代理再缩：1024×342。
        assert_eq!((d.width, d.height), (1024, 342));
        let want = (b.len() as f64 * 3000.0 * 1000.0 / (1024.0 * 342.0)).round() as u64;
        assert_eq!(r.bytes, want);

        // PNG：在长边 512 的代理上算；限制最长边按比例换算，尺寸报全尺寸下的输出。
        let r = st
            .preview(s, 2, png_compress(Some(1500)), false)
            .unwrap()
            .unwrap();
        assert!(r.approx);
        assert_eq!((r.width, r.height), (1500, 500));
        let (b, _) = st.bytes(s, 2).unwrap();
        let d = decode_rgba(&b, u64::MAX).unwrap();
        // 代理 512×171，限制最长边 1500 × 512 / 3000 = 256 → 256×86。
        assert_eq!((d.width, d.height), (256, 86));
        let want = (b.len() as f64 * 1500.0 * 500.0 / (256.0 * 86.0)).round() as u64;
        assert_eq!(r.bytes, want);

        // 全尺寸：精确值。
        let r = st
            .preview(s, 3, png_compress(Some(1500)), true)
            .unwrap()
            .unwrap();
        assert!(!r.approx);
        assert_eq!((r.width, r.height), (1500, 500));
        assert_eq!(r.bytes, st.bytes(s, 3).unwrap().0.len() as u64);
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
}
