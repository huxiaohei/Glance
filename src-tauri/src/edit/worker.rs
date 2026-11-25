//! 预览工作线程的请求槽：只留最新一个请求，新请求覆盖旧的；被覆盖、算完已过时或会话已关的请求一律应答 `None`。

use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Condvar, Mutex, MutexGuard};

use glance_imaging::EditParams;

use super::session::{EditError, PreviewResult};

pub type Answer = Result<Option<PreviewResult>, EditError>;

/// 一次预览请求；`reply` 只用一次。
pub struct Request {
    pub rev: u32,
    pub params: EditParams,
    pub full: bool,
    reply: SyncSender<Answer>,
}

impl Request {
    pub fn new(rev: u32, params: EditParams, full: bool) -> (Self, Receiver<Answer>) {
        let (tx, rx) = sync_channel(1);
        (
            Request {
                rev,
                params,
                full,
                reply: tx,
            },
            rx,
        )
    }

    fn answer(self, a: Answer) {
        // 等待方已不在（命令被取消）时忽略。
        let _ = self.reply.send(a);
    }
}

#[derive(Default)]
struct Slot {
    pending: Option<Request>,
    closed: bool,
}

#[derive(Default)]
pub struct Worker {
    slot: Mutex<Slot>,
    cv: Condvar,
}

impl Worker {
    fn lock(&self) -> MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 放入请求；槽里原有的请求应答 `None`。已关闭时这次请求直接应答 `None`。
    pub fn submit(&self, req: Request) {
        let mut slot = self.lock();
        if slot.closed {
            drop(slot);
            req.answer(Ok(None));
            return;
        }
        if let Some(old) = slot.pending.replace(req) {
            old.answer(Ok(None));
        }
        self.cv.notify_one();
    }

    /// 关闭：槽里未开始的请求应答 `None`，线程算完手头这次后退出。
    pub fn close(&self) {
        let mut slot = self.lock();
        slot.closed = true;
        let old = slot.pending.take();
        self.cv.notify_all();
        drop(slot);
        if let Some(old) = old {
            old.answer(Ok(None));
        }
    }

    /// 线程主体：取请求、在锁外计算；算完时若槽里已有更新请求或已关闭，结果丢弃并应答 `None`，
    /// 否则在锁内调用 `commit` 记下结果（与新请求的放入互斥）后应答。
    pub fn run<T>(
        &self,
        compute: impl Fn(&Request) -> Result<T, EditError>,
        commit: impl Fn(u32, T) -> PreviewResult,
    ) {
        loop {
            let req = {
                let mut slot = self.lock();
                loop {
                    if slot.closed {
                        return;
                    }
                    if let Some(r) = slot.pending.take() {
                        break r;
                    }
                    slot = self.cv.wait(slot).unwrap_or_else(|e| e.into_inner());
                }
            };
            // 计算若 panic，线程不能就此退出：否则之后的请求永远等不到应答。
            let out = std::panic::catch_unwind(AssertUnwindSafe(|| compute(&req)))
                .unwrap_or(Err(EditError::Encode));
            let slot = self.lock();
            if slot.pending.is_some() || slot.closed {
                drop(slot);
                req.answer(Ok(None));
                continue;
            }
            let answer = out.map(|t| Some(commit(req.rev, t)));
            drop(slot);
            req.answer(answer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glance_imaging::OutFormat;
    use std::sync::Arc;

    fn params() -> EditParams {
        EditParams::Convert {
            format: OutFormat::Jpeg,
            quality: 80,
            fill: [255; 3],
        }
    }

    #[test]
    fn panic_in_compute_answers_error_and_keeps_running() {
        let w = Arc::new(Worker::default());
        let t = {
            let w = w.clone();
            std::thread::spawn(move || {
                w.run(
                    |r: &Request| {
                        if r.rev == 1 {
                            panic!("boom");
                        }
                        Ok(r.rev)
                    },
                    |rev, _| PreviewResult {
                        rev,
                        bytes: 0,
                        approx: false,
                        format: OutFormat::Jpeg,
                        width: 1,
                        height: 1,
                    },
                )
            })
        };
        let (r1, rx1) = Request::new(1, params(), true);
        w.submit(r1);
        assert_eq!(rx1.recv().unwrap(), Err(EditError::Encode));
        let (r2, rx2) = Request::new(2, params(), true);
        w.submit(r2);
        assert_eq!(rx2.recv().unwrap().unwrap().unwrap().rev, 2);
        w.close();
        t.join().unwrap();
        let (r3, rx3) = Request::new(3, params(), true);
        w.submit(r3);
        assert_eq!(rx3.recv().unwrap(), Ok(None));
    }
}
