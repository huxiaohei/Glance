//! 预览工作线程的请求槽：只留最新一个请求，新请求覆盖旧的；被覆盖而未开始、算完已过时或会话已关的请求应答 `None`。
//! 版本号只进不退：比槽里或已提交的版本号小的请求立即应答 `None`，不顶掉更新的请求。
//! 算完时即使槽里已有更新的请求，只要比已提交的新就照样提交并应答：拖动中画面能跟着动，
//! 串行线程随后接着算槽里最新的那个。

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
    /// 最近提交的版本号。
    committed: Option<u32>,
    closed: bool,
}

impl Slot {
    /// 比槽里或已提交的版本号小：是迟到的旧请求。
    fn is_stale(&self, rev: u32) -> bool {
        self.pending.as_ref().is_some_and(|p| rev < p.rev)
            || self.committed.is_some_and(|c| rev < c)
    }
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

    /// 放入请求；槽里原有的请求应答 `None`。已关闭或版本号比槽里 / 已提交的小时，这次请求直接应答 `None`。
    pub fn submit(&self, req: Request) {
        let mut slot = self.lock();
        if slot.closed || slot.is_stale(req.rev) {
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

    /// 线程主体：取请求、在锁外计算；算完时若已关闭或比已提交的旧，结果丢弃并应答 `None`，
    /// 否则在锁内调用 `commit` 记下结果（与新请求的放入互斥）后应答；槽里有更新的请求不妨碍提交。
    /// `commit` 返回 `None` 表示这次结果在别处已过时（如另一条通道提交了更新的版本），不算已提交。
    pub fn run<T>(
        &self,
        compute: impl Fn(&Request) -> Result<T, EditError>,
        commit: impl Fn(u32, T) -> Option<PreviewResult>,
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
            let mut slot = self.lock();
            if slot.closed || slot.committed.is_some_and(|c| req.rev < c) {
                drop(slot);
                req.answer(Ok(None));
                continue;
            }
            let answer = out.map(|t| commit(req.rev, t));
            if let Ok(Some(_)) = answer {
                slot.committed = Some(req.rev);
            }
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

    fn result(rev: u32) -> PreviewResult {
        PreviewResult {
            rev,
            bytes: 0,
            approx: false,
            format: OutFormat::Jpeg,
            width: 1,
            height: 1,
        }
    }

    #[test]
    fn lower_rev_is_refused_and_newer_kept() {
        let w = Arc::new(Worker::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let (started_tx, started) = std::sync::mpsc::channel();
        let t = {
            let (w, gate) = (w.clone(), gate.clone());
            std::thread::spawn(move || {
                w.run(
                    |r: &Request| {
                        if r.rev == 1 {
                            started_tx.send(()).unwrap();
                            gate.wait();
                        }
                        Ok(r.rev)
                    },
                    |rev, _| Some(result(rev)),
                )
            })
        };
        // rev 1 在算；槽里放 rev 5，再来的 rev 3 立即应答 None，rev 5 留着。
        let (r1, rx1) = Request::new(1, params(), true);
        w.submit(r1);
        started.recv().unwrap();
        let (r5, rx5) = Request::new(5, params(), true);
        w.submit(r5);
        let (r3, rx3) = Request::new(3, params(), true);
        w.submit(r3);
        assert_eq!(rx3.recv().unwrap(), Ok(None));
        gate.wait();
        // rev 1 比已提交的新：算完照样交出去（槽里的 rev 5 随后再算）。
        assert_eq!(rx1.recv().unwrap().unwrap().unwrap().rev, 1);
        assert_eq!(rx5.recv().unwrap().unwrap().unwrap().rev, 5);
        // 已提交 rev 5 之后，更小的版本号同样不算。
        let (r4, rx4) = Request::new(4, params(), true);
        w.submit(r4);
        assert_eq!(rx4.recv().unwrap(), Ok(None));
        // 相同版本号可以重算。
        let (r5b, rx5b) = Request::new(5, params(), true);
        w.submit(r5b);
        assert_eq!(rx5b.recv().unwrap().unwrap().unwrap().rev, 5);
        w.close();
        t.join().unwrap();
    }

    /// 拖动中新请求不断到来：手头算完的结果只要比已提交的新，就提交并应答，画面能跟着动。
    #[test]
    fn intermediate_result_delivered_while_newer_pending() {
        let w = Arc::new(Worker::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let (started_tx, started) = std::sync::mpsc::channel();
        let t = {
            let (w, gate) = (w.clone(), gate.clone());
            std::thread::spawn(move || {
                w.run(
                    |r: &Request| {
                        if r.rev <= 2 {
                            started_tx.send(r.rev).unwrap();
                            gate.wait();
                        }
                        Ok(r.rev)
                    },
                    |rev, _| Some(result(rev)),
                )
            })
        };
        let (r1, rx1) = Request::new(1, params(), false);
        w.submit(r1);
        assert_eq!(started.recv().unwrap(), 1);
        // rev 1 在算时 rev 2 到来；rev 1 算完仍交出去。
        let (r2, rx2) = Request::new(2, params(), false);
        w.submit(r2);
        gate.wait();
        assert_eq!(rx1.recv().unwrap().unwrap().unwrap().rev, 1);
        // rev 2 在算时 rev 3、4 先后到来：3 未开始即被 4 顶掉，2 与 4 都交出去。
        assert_eq!(started.recv().unwrap(), 2);
        let (r3, rx3) = Request::new(3, params(), false);
        w.submit(r3);
        let (r4, rx4) = Request::new(4, params(), false);
        w.submit(r4);
        assert_eq!(rx3.recv().unwrap(), Ok(None));
        gate.wait();
        assert_eq!(rx2.recv().unwrap().unwrap().unwrap().rev, 2);
        assert_eq!(rx4.recv().unwrap().unwrap().unwrap().rev, 4);
        w.close();
        t.join().unwrap();
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
                    |rev, _| Some(result(rev)),
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
