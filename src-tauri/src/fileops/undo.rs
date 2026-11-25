//! 撤销步骤与只记一步的撤销日志。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use super::trash::TrashHandle;

/// 撤销一次操作时要执行的单个动作。
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Restore(TrashHandle),                    // 从废纸篓放回
    MoveBack { from: PathBuf, to: PathBuf }, // 把 from 移回 to（不覆盖）
    Trash(PathBuf),                          // 把新产生的文件移入废纸篓
    RemoveEmptyDir(PathBuf),                 // 目录为空才删，非空则跳过且不算失败
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Trash,
    Rename,
    Move,
    Copy,
    /// 编辑后保存（副本、覆盖或另存），整次一步撤销。
    Edit,
}

pub struct UndoEntry {
    pub token: u64,
    pub kind: OpKind,
    pub steps: Vec<Step>,
}

/// 只保留最近一次操作的撤销日志。
#[derive(Default)]
pub struct UndoLog {
    entry: Mutex<Option<UndoEntry>>,
    last_token: AtomicU64,
}

impl UndoLog {
    /// steps 为空时不记录、也不动已有的记录，返回 None；否则替换已有记录，返回新 token。
    pub fn record(&self, kind: OpKind, steps: Vec<Step>) -> Option<u64> {
        if steps.is_empty() {
            return None;
        }
        let token = self.last_token.fetch_add(1, Ordering::Relaxed) + 1;
        *self.lock() = Some(UndoEntry { token, kind, steps });
        Some(token)
    }

    /// token 与当前记录一致时把 steps 追加进去并返回 true（“保留两者”与原操作算同一次）。
    pub fn extend(&self, token: u64, steps: Vec<Step>) -> bool {
        match self.lock().as_mut() {
            Some(entry) if entry.token == token => {
                entry.steps.extend(steps);
                true
            }
            _ => false,
        }
    }

    pub fn take(&self) -> Option<UndoEntry> {
        self.lock().take()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<UndoEntry>> {
        // 锁内只做赋值，不会在持锁时 panic 留下半截状态。
        self.entry.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trash_step(name: &str) -> Step {
        Step::Trash(PathBuf::from(name))
    }

    #[test]
    fn undo_log_keeps_only_the_latest_and_extends_by_token() {
        let log = UndoLog::default();
        let first = log.record(OpKind::Copy, vec![trash_step("a")]).unwrap();
        let second = log.record(OpKind::Move, vec![trash_step("b")]).unwrap();
        assert_ne!(first, second);

        assert!(!log.extend(first, vec![trash_step("stale")]));
        assert!(log.extend(second, vec![trash_step("c")]));
        // 空 steps 不覆盖已有记录。
        assert_eq!(log.record(OpKind::Rename, Vec::new()), None);

        let entry = log.take().unwrap();
        assert_eq!(entry.token, second);
        assert_eq!(entry.kind, OpKind::Move);
        assert_eq!(entry.steps, vec![trash_step("b"), trash_step("c")]);
        assert!(log.take().is_none());
        assert!(!log.extend(second, vec![trash_step("d")]));
    }
}
