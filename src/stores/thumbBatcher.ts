import type { ThumbEvent } from "../ipc/types";

/** 把缩略图事件攒起来，每帧最多向 store 冲刷一次（一次 Map 拷贝）。scheduler 可注入以便测试。 */
export function createThumbBatcher(
  flush: (events: ThumbEvent[]) => void,
  schedule: (cb: () => void) => void = (cb) => void requestAnimationFrame(cb),
) {
  let queue: ThumbEvent[] = [];
  let scheduled = false;
  return {
    push(e: ThumbEvent) {
      queue.push(e);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const events = queue;
        queue = [];
        flush(events);
      });
    },
  };
}
