//! 批量任务：专用工作线程并行处理、可取消、节流推送进度，整批算一次撤销。

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use glance_imaging::EditParams;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::plan::{BatchOp, BatchPlan, SkipItem, plan};
use crate::catalog::reconcile::FsHint;
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::session::Sessions;
use crate::edit::EditError;
use crate::edit::commands::naming;
use crate::edit::render::render_path;
use crate::fileops::edit_save::write_new;
use crate::fileops::fsx::FsError;
use crate::fileops::undo::{OpKind, Step, UndoLog};
use crate::state::settings::{SettingsState, batch_dir_name};

/// 进度推送的最小间隔（最后一次必发）。
const PUSH_EVERY: Duration = Duration::from_millis(100);
/// 并行数上限。
const MAX_WORKERS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailReason {
    NotFound,
    Decode,
    TooLarge,
    Encode,
    ReadOnly,
    DiskFull,
    Denied,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub id: u32,
    pub name: String,
    pub reason: FailReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub processed: u32,
    pub failed: Vec<Failure>,
    pub skipped: Vec<SkipItem>,
    pub saved_bytes: i64,
    pub token: Option<u64>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        done: u32,
        total: u32,
        failed: u32,
        saved_bytes: i64,
    },
    Finished(BatchSummary),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchError {
    Busy,
    Invalid,
    NoRoot,
}

/// 任务对外的出口：给会话投提示、记撤销。应用里由 `AppHandle` 实现，测试里直接构造。
pub trait JobEnv: Send + Sync + 'static {
    fn hint(&self, hints: Vec<FsHint>);
    fn record(&self, kind: OpKind, steps: Vec<Step>) -> Option<u64>;
    /// 测试钩子：工作线程每次取下一张之前调用（在查取消标志之前）。
    #[cfg(test)]
    fn before_item(&self) {}
}

pub struct JobCtx {
    pub registry: Arc<Registry>,
    /// 会话根；None 表示没有打开的目录。
    pub root: Option<PathBuf>,
    /// 输出目录名（相对会话根）。
    pub out_dir: String,
    pub env: Arc<dyn JobEnv>,
}

impl From<EditError> for FailReason {
    /// `Animated` / `Unsupported` 在开始前已筛成跳过；运行中才发现的记 `Other`。
    fn from(e: EditError) -> Self {
        match e {
            EditError::NotFound => FailReason::NotFound,
            EditError::Decode => FailReason::Decode,
            EditError::TooLarge => FailReason::TooLarge,
            EditError::Encode => FailReason::Encode,
            _ => FailReason::Other,
        }
    }
}

impl From<FsError> for FailReason {
    fn from(e: FsError) -> Self {
        match e {
            FsError::NotFound => FailReason::NotFound,
            FsError::ReadOnly => FailReason::ReadOnly,
            FsError::DiskFull => FailReason::DiskFull,
            FsError::Denied => FailReason::Denied,
            FsError::TooLarge => FailReason::TooLarge,
            _ => FailReason::Other,
        }
    }
}

/// 应用里的出口：提示投给当前会话，撤销记进全局撤销日志。
struct AppEnv(AppHandle);

impl JobEnv for AppEnv {
    fn hint(&self, hints: Vec<FsHint>) {
        self.0.state::<Sessions>().hint(hints);
    }

    fn record(&self, kind: OpKind, steps: Vec<Step>) -> Option<u64> {
        self.0.state::<UndoLog>().record(kind, steps)
    }
}

struct Running {
    job: u32,
    cancel: Arc<AtomicBool>,
}

/// 至多一个批量任务。
#[derive(Default)]
pub struct BatchState {
    current: Arc<Mutex<Option<Running>>>,
    last_job: AtomicU32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 并行数：留两个核给界面与看图，至少 1、至多 4，且不超过张数。
fn worker_count(items: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    cores.saturating_sub(2).clamp(1, MAX_WORKERS).min(items)
}

type Sink = Arc<dyn Fn(BatchEvent) + Send + Sync>;

impl BatchState {
    /// 开始一个批量任务，返回任务号。参数不是压缩 / 转格式 → `Invalid`；已有任务 → `Busy`；
    /// 没有会话根 → `NoRoot`。清单、处理与收尾都在后台线程上做，结束时先推 `Finished` 再释放。
    pub fn start(
        &self,
        ctx: JobCtx,
        ids: Vec<FileId>,
        params: EditParams,
        sink: impl Fn(BatchEvent) + Send + Sync + 'static,
    ) -> Result<u32, BatchError> {
        let op = match params {
            EditParams::Compress { .. } => BatchOp::Compress,
            EditParams::Convert { .. } => BatchOp::Convert,
            _ => return Err(BatchError::Invalid),
        };
        let mut cur = lock(&self.current);
        if cur.is_some() {
            return Err(BatchError::Busy);
        }
        let root = ctx.root.clone().ok_or(BatchError::NoRoot)?;
        let job = self.last_job.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let run = Job {
            ctx,
            root,
            params,
            cancel: Arc::clone(&cancel),
            sink: Arc::new(sink),
        };
        let current = Arc::clone(&self.current);
        std::thread::Builder::new()
            .name("glance-batch".into())
            .spawn(move || {
                // 线程里才建：起线程失败时闭包在持锁处被丢弃，不能在那里再去拿锁。
                let _release = Release { current, job };
                run.execute(ids, op);
            })
            // 起不了线程：按“忙”处理，前端提示稍后再试。
            .map_err(|_| BatchError::Busy)?;
        *cur = Some(Running { job, cancel });
        Ok(job)
    }

    /// 取消任务 `job`：已在处理的那几张做完，其余不再开始。不是当前任务则什么都不做。
    pub fn cancel(&self, job: u32) {
        if let Some(r) = lock(&self.current).as_ref()
            && r.job == job
        {
            r.cancel.store(true, Ordering::Release);
        }
    }
}

/// 任务线程结束（含 panic 展开）时释放“当前任务”。
struct Release {
    current: Arc<Mutex<Option<Running>>>,
    job: u32,
}

impl Drop for Release {
    fn drop(&mut self) {
        let mut cur = lock(&self.current);
        if cur.as_ref().is_some_and(|r| r.job == self.job) {
            *cur = None;
        }
    }
}

struct Job {
    ctx: JobCtx,
    root: PathBuf,
    params: EditParams,
    cancel: Arc<AtomicBool>,
    sink: Sink,
}

/// 一张成功的产出。
struct Output {
    index: usize,
    path: PathBuf,
    new_dirs: Vec<PathBuf>,
}

#[derive(Default)]
struct Tally {
    done: u32,
    failed: Vec<(usize, Failure)>,
    saved_bytes: i64,
    outputs: Vec<Output>,
    last_push: Option<Instant>,
}

impl Job {
    fn execute(self, ids: Vec<FileId>, op: BatchOp) {
        let BatchPlan { process, skipped } =
            plan(&self.ctx.registry, &self.root, &ids, op, &self.ctx.out_dir);
        let total = process.len() as u32;
        let queue: Mutex<VecDeque<(usize, FileId)>> =
            Mutex::new(process.into_iter().map(FileId).enumerate().collect());
        let tally = Mutex::new(Tally::default());
        let n = worker_count(total as usize);
        std::thread::scope(|s| {
            let mut spawned = 0;
            for i in 0..n {
                let ok = std::thread::Builder::new()
                    .name(format!("glance-batch-{}", i + 1))
                    .spawn_scoped(s, || self.work(&queue, &tally, total))
                    .is_ok();
                spawned += usize::from(ok);
            }
            // 一个工作线程都起不来：在任务线程上自己做（它也不是主线程）。
            if spawned == 0 && n > 0 {
                self.work(&queue, &tally, total);
            }
        });
        let mut t = tally.into_inner().unwrap_or_else(|e| e.into_inner());
        t.outputs.sort_by_key(|o| o.index);
        t.failed.sort_by_key(|(i, _)| *i);
        let token = if t.outputs.is_empty() {
            None
        } else {
            self.ctx.env.record(OpKind::Batch, undo_steps(&t.outputs))
        };
        let failed: Vec<Failure> = t.failed.into_iter().map(|(_, f)| f).collect();
        (self.sink)(BatchEvent::Progress {
            done: t.done,
            total,
            failed: failed.len() as u32,
            saved_bytes: t.saved_bytes,
        });
        (self.sink)(BatchEvent::Finished(BatchSummary {
            processed: t.outputs.len() as u32,
            failed,
            skipped,
            saved_bytes: t.saved_bytes,
            token,
            cancelled: self.cancel.load(Ordering::Acquire),
        }));
    }

    /// 工作线程：每次取下一张前先查取消标志，已取消就不再开始。
    fn work(&self, queue: &Mutex<VecDeque<(usize, FileId)>>, tally: &Mutex<Tally>, total: u32) {
        loop {
            #[cfg(test)]
            self.ctx.env.before_item();
            if self.cancel.load(Ordering::Acquire) {
                return;
            }
            let Some((index, id)) = lock(queue).pop_front() else {
                return;
            };
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| self.one(id)))
                .unwrap_or(Err(FailReason::Encode));
            // 提示、登记与取名都在锁外做，锁里只记账。
            let entry = match result {
                Ok(done) => {
                    self.ctx.env.hint(vec![FsHint::Touched(done.path.clone())]);
                    self.ctx.registry.register(&done.path);
                    Ok(done)
                }
                Err(reason) => {
                    let name = self
                        .ctx
                        .registry
                        .path(id)
                        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                        .unwrap_or_default();
                    Err(Failure {
                        id: id.0,
                        name,
                        reason,
                    })
                }
            };
            let mut t = lock(tally);
            match entry {
                Ok(done) => {
                    t.saved_bytes += done.src_size as i64 - done.out_size as i64;
                    t.outputs.push(Output {
                        index,
                        path: done.path,
                        new_dirs: done.new_dirs,
                    });
                }
                Err(f) => t.failed.push((index, f)),
            }
            t.done += 1;
            let now = Instant::now();
            if t.last_push
                .is_none_or(|p| now.duration_since(p) >= PUSH_EVERY)
            {
                t.last_push = Some(now);
                // 持锁推送：各线程的进度按序到达，done 不回退。
                (self.sink)(BatchEvent::Progress {
                    done: t.done,
                    total,
                    failed: t.failed.len() as u32,
                    saved_bytes: t.saved_bytes,
                });
            }
        }
    }

    /// 处理一张：编码、按相对路径落到输出目录、不覆盖地写新文件。
    fn one(&self, id: FileId) -> Result<Done, FailReason> {
        let src = self.ctx.registry.path(id).ok_or(FailReason::NotFound)?;
        let rel = src
            .strip_prefix(&self.root)
            .map_err(|_| FailReason::NotFound)?;
        let (enc, src_format, src_size) = render_path(&src, &self.params)?;
        // 批量只要扩展名，不加 `_compressed` 之类的后缀。
        let (ext, _) = naming(&src, src_format, &self.params, enc.format);
        let stem = src.file_stem().ok_or(FailReason::Other)?.to_string_lossy();
        let mut dir = self.root.join(&self.ctx.out_dir);
        if let Some(parent) = rel.parent().filter(|p| !p.as_os_str().is_empty()) {
            dir.push(parent);
        }
        let w = write_new(&dir, &format!("{stem}.{ext}"), &enc.bytes)?;
        Ok(Done {
            path: w.path,
            new_dirs: w.new_dirs,
            src_size,
            out_size: enc.bytes.len() as u64,
        })
    }
}

struct Done {
    path: PathBuf,
    new_dirs: Vec<PathBuf>,
    src_size: u64,
    out_size: u64,
}

/// 整批的撤销步骤。撤销按倒序执行，所以目录放在前面（浅的在前）、产出放在后面：
/// 执行时先把产出移进废纸篓，再由深到浅删本次新建、已变空的目录。
fn undo_steps(outputs: &[Output]) -> Vec<Step> {
    let mut dirs: Vec<&PathBuf> = outputs.iter().flat_map(|o| &o.new_dirs).collect();
    dirs.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });
    dirs.dedup();
    dirs.into_iter()
        .map(|d| Step::RemoveEmptyDir(d.clone()))
        .chain(outputs.iter().map(|o| Step::Trash(o.path.clone())))
        .collect()
}

/// 开始批量处理：`ids` 再经一次清单筛选，结果与进度经 `on_event` 推送，返回任务号。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn batch_start(
    ids: Vec<u32>,
    params: EditParams,
    on_event: Channel<BatchEvent>,
    app: AppHandle,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    settings: State<'_, SettingsState>,
    batch: State<'_, BatchState>,
) -> Result<u32, BatchError> {
    let ctx = JobCtx {
        registry: Arc::clone(&registry),
        root: sessions.root(),
        out_dir: batch_dir_name(&settings.get()),
        env: Arc::new(AppEnv(app)),
    };
    let ids = ids.into_iter().map(FileId).collect();
    batch.start(ctx, ids, params, move |e| {
        // 前端已离开（窗口重载等）时发送失败，不是错误。
        let _ = on_event.send(e);
    })
}

/// 取消批量任务：已开始的那几张做完，其余不再开始。
#[tauri::command(async)]
pub fn batch_cancel(job: u32, batch: State<'_, BatchState>) {
    batch.cancel(job);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::details::testimg::{jpeg, png};
    use crate::edit::render::render_path;
    use crate::fileops::ops;
    use crate::fileops::undo::UndoLog;
    use glance_imaging::{CropRect, OutFormat, PngMode};
    use std::fs;
    use std::path::Path;
    use std::sync::Condvar;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::Duration;

    const OUT: &str = "_glance_output";

    /// 一次打开、永不再关的闸门。
    #[derive(Default)]
    struct Gate {
        open: Mutex<bool>,
        cv: Condvar,
    }

    impl Gate {
        fn wait(&self) {
            let mut g = lock(&self.open);
            while !*g {
                g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
            }
        }

        fn open(&self) {
            *lock(&self.open) = true;
            self.cv.notify_all();
        }
    }

    struct TestEnv {
        undo: UndoLog,
        touched: Sender<PathBuf>,
        /// Some(n)：前 n 次 before_item 放行，之后的每次都先报到再等闸门。
        pass: Option<usize>,
        calls: AtomicUsize,
        gate: Gate,
        blocked: Sender<()>,
    }

    impl JobEnv for TestEnv {
        fn hint(&self, hints: Vec<FsHint>) {
            for h in hints {
                if let FsHint::Touched(p) = h {
                    let _ = self.touched.send(p);
                }
            }
        }

        fn record(&self, kind: OpKind, steps: Vec<Step>) -> Option<u64> {
            self.undo.record(kind, steps)
        }

        fn before_item(&self) {
            if let Some(pass) = self.pass
                && self.calls.fetch_add(1, Ordering::SeqCst) >= pass
            {
                let _ = self.blocked.send(());
                self.gate.wait();
            }
        }
    }

    struct Harness {
        env: Arc<TestEnv>,
        touched: Receiver<PathBuf>,
        blocked: Receiver<()>,
        reg: Arc<Registry>,
        root: PathBuf,
    }

    impl Harness {
        fn new(root: &Path, pass: Option<usize>) -> Self {
            let (ttx, touched) = mpsc::channel();
            let (btx, blocked) = mpsc::channel();
            Harness {
                env: Arc::new(TestEnv {
                    undo: UndoLog::default(),
                    touched: ttx,
                    pass,
                    calls: AtomicUsize::new(0),
                    gate: Gate::default(),
                    blocked: btx,
                }),
                touched,
                blocked,
                reg: Arc::new(Registry::default()),
                root: root.to_path_buf(),
            }
        }

        fn put(&self, rel: &str, bytes: &[u8]) -> FileId {
            let p = self.root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, bytes).unwrap();
            self.reg.register(&p)
        }

        fn ctx(&self) -> JobCtx {
            JobCtx {
                registry: Arc::clone(&self.reg),
                root: Some(self.root.clone()),
                out_dir: OUT.into(),
                env: self.env.clone(),
            }
        }

        fn start(
            &self,
            st: &BatchState,
            ids: Vec<FileId>,
            params: EditParams,
        ) -> (Result<u32, BatchError>, Receiver<BatchEvent>) {
            let (tx, rx) = mpsc::channel();
            let r = st.start(self.ctx(), ids, params, move |e| {
                let _ = tx.send(e);
            });
            (r, rx)
        }

        fn out(&self, rel: &str) -> PathBuf {
            self.root.join(OUT).join(rel)
        }
    }

    /// 收集事件直到 Finished（超时只是防止测试挂死，不用于同步）。
    fn finish(rx: &Receiver<BatchEvent>) -> (Vec<BatchEvent>, BatchSummary) {
        let mut events = Vec::new();
        loop {
            let e = rx
                .recv_timeout(Duration::from_secs(60))
                .expect("批量任务没有结束");
            if let BatchEvent::Finished(s) = &e {
                let s = s.clone();
                events.push(e);
                return (events, s);
            }
            events.push(e);
        }
    }

    fn compress() -> EditParams {
        EditParams::Compress {
            quality: 80,
            max_edge: None,
            png_mode: PngMode::Lossless,
        }
    }

    fn to_webp() -> EditParams {
        EditParams::Convert {
            format: OutFormat::Webp,
            quality: 85,
            fill: [255; 3],
        }
    }

    #[test]
    fn outputs_mirror_relative_paths() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let a_bytes = png(16, 12);
        let b_bytes = jpeg(16, 12);
        let a = h.put("a.png", &a_bytes);
        let b = h.put("sub/b.jpg", &b_bytes);
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![a, b], compress());
        r.unwrap();
        let (_, s) = finish(&rx);
        assert_eq!(s.processed, 2);
        assert!(s.failed.is_empty() && s.skipped.is_empty());
        assert!(!s.cancelled);
        assert!(s.token.is_some());
        assert!(h.out("a.png").is_file());
        assert!(h.out("sub/b.jpg").is_file());
        assert_eq!(fs::read(t.path().join("a.png")).unwrap(), a_bytes);
        assert_eq!(fs::read(t.path().join("sub/b.jpg")).unwrap(), b_bytes);
    }

    #[test]
    fn batch_bytes_equal_single_render() {
        let t = tempfile::tempdir().unwrap();
        for (params, out) in [(compress(), "a.png"), (to_webp(), "a.webp")] {
            let _ = fs::remove_dir_all(t.path().join(OUT));
            let h = Harness::new(t.path(), None);
            let a = h.put("a.png", &png(20, 10));
            let st = BatchState::default();
            let (r, rx) = h.start(&st, vec![a], params.clone());
            r.unwrap();
            let (_, s) = finish(&rx);
            assert_eq!(s.processed, 1);
            let (enc, _, size) = render_path(&t.path().join("a.png"), &params).unwrap();
            assert_eq!(fs::read(h.out(out)).unwrap(), enc.bytes);
            assert_eq!(s.saved_bytes, size as i64 - enc.bytes.len() as i64);
        }
    }

    #[test]
    fn same_stem_different_ext_converts_to_numbered() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let a = h.put("a.png", &png(8, 8));
        let b = h.put("a.jpg", &jpeg(8, 8));
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![a, b], to_webp());
        r.unwrap();
        let (_, s) = finish(&rx);
        assert_eq!(s.processed, 2);
        assert!(h.out("a.webp").is_file());
        assert!(h.out("a_2.webp").is_file());
    }

    #[test]
    fn nested_dirs_created_and_removed_on_undo() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let c = h.put("x/y/c.png", &png(8, 8));
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![c], compress());
        r.unwrap();
        let (_, s) = finish(&rx);
        assert!(h.out("x/y/c.png").is_file());
        let entry = h.env.undo.take().unwrap();
        assert_eq!(Some(entry.token), s.token);
        assert_eq!(entry.kind, OpKind::Batch);
        let undone = ops::undo(&entry.steps);
        assert!(undone.failed.is_empty(), "{:?}", undone.failed);
        assert!(!h.out("x/y").exists());
        assert!(!h.out("x").exists());
        assert!(!t.path().join(OUT).exists());
        assert!(t.path().join("x/y/c.png").is_file());

        // 输出目录事先就有别的文件：只删本次新建的。
        let t2 = tempfile::tempdir().unwrap();
        let h2 = Harness::new(t2.path(), None);
        fs::create_dir(t2.path().join(OUT)).unwrap();
        fs::write(h2.out("keep.txt"), b"k").unwrap();
        let c2 = h2.put("x/y/c.png", &png(8, 8));
        let (r, rx) = h2.start(&st, vec![c2], compress());
        r.unwrap();
        finish(&rx);
        let entry = h2.env.undo.take().unwrap();
        assert!(ops::undo(&entry.steps).failed.is_empty());
        assert!(!h2.out("x").exists());
        assert!(h2.out("keep.txt").is_file());
    }

    #[test]
    fn missing_source_is_failure_not_abort() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), Some(0));
        let a = h.put("a.png", &png(8, 8));
        let b = h.put("b.png", &png(8, 8));
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![a, b], compress());
        r.unwrap();
        // 清单已筛过、工作线程还没开始：此时删掉源文件，registry 不动。
        h.blocked.recv().unwrap();
        fs::remove_file(t.path().join("b.png")).unwrap();
        h.env.gate.open();
        let (_, s) = finish(&rx);
        assert_eq!(s.processed, 1);
        assert_eq!(
            s.failed,
            vec![Failure {
                id: b.0,
                name: "b.png".into(),
                reason: FailReason::NotFound
            }]
        );
        assert!(s.skipped.is_empty());
        assert!(h.out("a.png").is_file());
    }

    #[test]
    fn cancel_before_start_writes_nothing() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), Some(0));
        let ids: Vec<FileId> = (0..4)
            .map(|i| h.put(&format!("{i}.png"), &png(8, 8)))
            .collect();
        let st = BatchState::default();
        let (r, rx) = h.start(&st, ids, compress());
        let job = r.unwrap();
        h.blocked.recv().unwrap();
        st.cancel(job);
        h.env.gate.open();
        let (_, s) = finish(&rx);
        assert!(s.cancelled);
        assert_eq!(s.processed, 0);
        assert!(s.failed.is_empty());
        assert_eq!(s.token, None);
        assert!(h.env.undo.take().is_none());
        assert!(!t.path().join(OUT).exists());
    }

    #[test]
    fn cancel_keeps_finished() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), Some(1));
        let ids: Vec<FileId> = (0..4)
            .map(|i| h.put(&format!("{i}.png"), &png(8, 8)))
            .collect();
        let st = BatchState::default();
        let (r, rx) = h.start(&st, ids, compress());
        let job = r.unwrap();
        // 第一张写完（提示发出）后再取消，其余工作线程都停在闸门前。
        let done = h.touched.recv().unwrap();
        st.cancel(job);
        h.env.gate.open();
        let (_, s) = finish(&rx);
        assert!(s.cancelled);
        assert_eq!(s.processed, 1);
        assert!(done.is_file());
        let entry = h.env.undo.take().unwrap();
        assert_eq!(Some(entry.token), s.token);
        assert!(entry.steps.contains(&Step::Trash(done.clone())));
        let outputs: Vec<_> = fs::read_dir(t.path().join(OUT))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(outputs, vec![done]);
    }

    #[test]
    fn second_start_is_busy() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), Some(0));
        let a = h.put("a.png", &png(8, 8));
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![a], compress());
        let job = r.unwrap();
        let (r2, _rx2) = h.start(&st, vec![a], compress());
        assert_eq!(r2, Err(BatchError::Busy));
        // 不是当前任务的取消什么都不做。
        st.cancel(job + 1);
        h.env.gate.open();
        let (_, s) = finish(&rx);
        assert!(!s.cancelled);
        assert_eq!(s.processed, 1);
    }

    #[test]
    fn invalid_params_rejected() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let a = h.put("a.png", &png(8, 8));
        let st = BatchState::default();
        let crop = EditParams::Crop {
            rect: CropRect {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            },
            quarter_turns: 0,
            flip_h: false,
            flip_v: false,
        };
        let (r, _rx) = h.start(&st, vec![a], crop);
        assert_eq!(r, Err(BatchError::Invalid));
        // 被拒后不占着“当前任务”。
        let (r, rx) = h.start(&st, vec![a], compress());
        r.unwrap();
        finish(&rx);
    }

    #[test]
    fn no_root_rejected() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let a = h.put("a.png", &png(8, 8));
        let st = BatchState::default();
        let mut ctx = h.ctx();
        ctx.root = None;
        let r = st.start(ctx, vec![a], compress(), |_| {});
        assert_eq!(r, Err(BatchError::NoRoot));
    }

    #[cfg(unix)]
    #[test]
    fn readonly_root_all_fail_no_undo() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let a = h.put("a.png", &png(8, 8));
        let b = h.put("b.png", &png(8, 8));
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let st = BatchState::default();
        let (r, rx) = h.start(&st, vec![a, b], compress());
        r.unwrap();
        let (_, s) = finish(&rx);
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(s.processed, 0);
        assert_eq!(s.failed.len(), 2);
        for f in &s.failed {
            assert!(
                matches!(f.reason, FailReason::Denied | FailReason::ReadOnly),
                "{f:?}"
            );
        }
        assert_eq!(s.token, None);
        assert!(h.env.undo.take().is_none());
        assert!(!t.path().join(OUT).exists());
    }

    #[test]
    fn progress_last_event_is_complete() {
        let t = tempfile::tempdir().unwrap();
        let h = Harness::new(t.path(), None);
        let ids: Vec<FileId> = (0..5)
            .map(|i| h.put(&format!("{i}.png"), &png(8, 8)))
            .collect();
        let st = BatchState::default();
        let (r, rx) = h.start(&st, ids, compress());
        r.unwrap();
        let (events, s) = finish(&rx);
        let n = events.len();
        assert!(n >= 2);
        assert!(matches!(events[n - 1], BatchEvent::Finished(_)));
        match &events[n - 2] {
            BatchEvent::Progress {
                done,
                total,
                failed,
                saved_bytes,
            } => {
                assert_eq!((*done, *total, *failed), (5, 5, 0));
                assert_eq!(*saved_bytes, s.saved_bytes);
            }
            e => panic!("倒数第二个应是进度：{e:?}"),
        }
        let mut last = 0;
        for e in &events[..n - 1] {
            let BatchEvent::Progress { done, .. } = e else {
                panic!("中间只应有进度")
            };
            assert!(*done >= last);
            last = *done;
        }
    }

    #[test]
    fn events_serialize_camel_case() {
        let e = BatchEvent::Progress {
            done: 1,
            total: 2,
            failed: 0,
            saved_bytes: -3,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"kind": "progress", "done": 1, "total": 2, "failed": 0, "savedBytes": -3})
        );
        let f = BatchEvent::Finished(BatchSummary {
            processed: 0,
            failed: vec![Failure {
                id: 1,
                name: "a.png".into(),
                reason: FailReason::DiskFull,
            }],
            skipped: Vec::new(),
            saved_bytes: 0,
            token: None,
            cancelled: true,
        });
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({"kind": "finished", "processed": 0,
                "failed": [{"id": 1, "name": "a.png", "reason": "diskFull"}],
                "skipped": [], "savedBytes": 0, "token": null, "cancelled": true})
        );
    }
}
