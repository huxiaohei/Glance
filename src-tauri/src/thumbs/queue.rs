//! 按消费者分组的待办队列。纯数据结构，不涉及线程。

use std::collections::{HashSet, VecDeque};

use super::Tier;
use crate::catalog::registry::FileId;

pub type Job = (FileId, Tier);

#[derive(Default)]
pub struct WantQueue {
    /// 越靠前越是最近一次 set 的消费者。
    consumers: Vec<(String, VecDeque<Job>)>,
    /// 已派发、尚未 finish 的任务；期间不会再被 pop 出来。
    in_flight: HashSet<Job>,
}

impl WantQueue {
    /// 整体替换该消费者想要的集合；jobs 里靠前的优先级更高，重复的只保留第一次出现。
    pub fn set(&mut self, consumer: &str, jobs: Vec<Job>) {
        self.consumers.retain(|(name, _)| name != consumer);
        let mut seen = HashSet::new();
        let jobs = jobs.into_iter().filter(|job| seen.insert(*job)).collect();
        self.consumers.insert(0, (consumer.to_owned(), jobs));
    }

    /// 取下一个任务：最近一次 set 的消费者优先，其内按 jobs 顺序；
    /// 进行中的任务跳过（仍留在原处），直到它 finish。
    pub fn pop(&mut self) -> Option<Job> {
        for (_, jobs) in &mut self.consumers {
            if let Some(pos) = jobs.iter().position(|job| !self.in_flight.contains(job)) {
                let job = jobs.remove(pos)?;
                self.in_flight.insert(job);
                return Some(job);
            }
        }
        None
    }

    /// 任务处理完毕（无论结果）：结束“进行中”，并从所有消费者的待办里去掉它。
    /// 之后若还要，需要再次 set。
    pub fn finish(&mut self, job: Job) {
        self.in_flight.remove(&job);
        for (_, jobs) in &mut self.consumers {
            jobs.retain(|j| *j != job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::FileId;
    use crate::thumbs::Tier;

    fn j(n: u32) -> Job {
        (FileId(n), Tier::S)
    }

    #[test]
    fn pops_in_given_order() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1), j(2), j(3)]);
        assert_eq!(
            [q.pop(), q.pop(), q.pop(), q.pop()],
            [Some(j(1)), Some(j(2)), Some(j(3)), None]
        );
    }

    #[test]
    fn set_replaces_that_consumers_wants() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1), j(2), j(3)]);
        q.set("grid", vec![j(3), j(4)]);
        assert_eq!([q.pop(), q.pop(), q.pop()], [Some(j(3)), Some(j(4)), None]);
    }

    #[test]
    fn consumers_do_not_cancel_each_other_and_latest_goes_first() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1), j(2)]);
        q.set("strip", vec![j(9)]);
        assert_eq!(
            [q.pop(), q.pop(), q.pop(), q.pop()],
            [Some(j(9)), Some(j(1)), Some(j(2)), None]
        );
    }

    #[test]
    fn shared_job_is_popped_once_and_tiers_are_distinct() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1)]);
        q.set("strip", vec![j(1), (FileId(1), Tier::L)]);
        assert_eq!(
            [q.pop(), q.pop(), q.pop()],
            [Some(j(1)), Some((FileId(1), Tier::L)), None]
        );
    }

    #[test]
    fn job_in_flight_is_not_handed_out_twice() {
        let mut q = WantQueue::default();
        q.set("a", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
        q.set("b", vec![j(1)]);
        assert_eq!(q.pop(), None);
        q.finish(j(1));
        // 完成后想再要，需要重新 set。
        q.set("b", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
    }

    #[test]
    fn finished_job_nobody_wants_is_not_requeued() {
        let mut q = WantQueue::default();
        q.set("a", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
        q.finish(j(1));
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn finished_job_is_dropped_from_all_consumers() {
        let mut q = WantQueue::default();
        q.set("a", vec![j(1)]);
        q.set("b", vec![j(1), j(2)]);
        assert_eq!(q.pop(), Some(j(1)));
        assert_eq!(q.pop(), Some(j(2)));
        q.finish(j(1));
        q.finish(j(2));
        // a 里仍挂着的 j1 不会被再次派发。
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn duplicate_ids_in_one_request_are_collapsed() {
        let mut q = WantQueue::default();
        q.set("a", vec![j(1), j(1), j(2)]);
        assert_eq!([q.pop(), q.pop(), q.pop()], [Some(j(1)), Some(j(2)), None]);
    }

    #[test]
    fn job_can_be_requested_again_after_finish() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
        q.finish(j(1));
        q.set("grid", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
    }
}
