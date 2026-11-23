//! 按消费者分组的待办队列。纯数据结构，不涉及线程。

use std::collections::{HashSet, VecDeque};

use super::Tier;
use crate::catalog::registry::FileId;

pub type Job = (FileId, Tier);

#[derive(Default)]
pub struct WantQueue {
    /// 越靠前越是最近一次 set 的消费者。
    consumers: Vec<(String, VecDeque<Job>)>,
    /// 已经取出过的任务；仍在某个消费者的集合里时不会再被取出。
    popped: HashSet<Job>,
}

impl WantQueue {
    /// 整体替换该消费者想要的集合；jobs 里靠前的优先级更高。
    pub fn set(&mut self, consumer: &str, jobs: Vec<Job>) {
        self.consumers.retain(|(name, _)| name != consumer);
        // 重新被 set 进来的任务允许再次取出。
        for job in &jobs {
            self.popped.remove(job);
        }
        self.consumers
            .insert(0, (consumer.to_owned(), jobs.into_iter().collect()));
    }

    /// 取下一个任务：最近一次 set 的消费者优先，其内按 jobs 顺序；
    /// 同一个任务不会被取出两次，除非之后又被 set 进来。
    pub fn pop(&mut self) -> Option<Job> {
        for (_, jobs) in &mut self.consumers {
            while let Some(job) = jobs.pop_front() {
                if self.popped.insert(job) {
                    return Some(job);
                }
            }
        }
        None
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
    fn popped_job_can_be_requested_again() {
        let mut q = WantQueue::default();
        q.set("grid", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
        q.set("grid", vec![j(1)]);
        assert_eq!(q.pop(), Some(j(1)));
    }
}
