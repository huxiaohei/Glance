//! 缩略图管线：磁盘缓存、按消费者的待办队列、工作线程。

pub mod cache;
pub mod queue;
pub mod worker;

pub use cache::ThumbCache;
pub use worker::{ThumbEvent, Thumbs};

/// 缩略图档位，数值是长边像素。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Tier {
    S,
    L,
}

impl Tier {
    pub fn px(self) -> u32 {
        match self {
            Tier::S => 320,
            Tier::L => 640,
        }
    }

    /// 只接受 320 和 640。
    pub fn from_px(px: u32) -> Option<Tier> {
        match px {
            320 => Some(Tier::S),
            640 => Some(Tier::L),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_roundtrip() {
        assert_eq!((Tier::S.px(), Tier::L.px()), (320, 640));
        assert_eq!(Tier::from_px(320), Some(Tier::S));
        assert_eq!(Tier::from_px(640), Some(Tier::L));
        assert_eq!(Tier::from_px(321), None);
    }
}
