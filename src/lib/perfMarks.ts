/** 保留最近这么多次切图耗时。 */
const CAPACITY = 200;

export interface SwitchStats { count: number; p50: number; p95: number; max: number }

export interface SwitchTimer {
  markSwitchStart(): void;
  markSwitchPainted(): void;
  switchStats(): SwitchStats;
}

/** 按最近秩取百分位：排序后第 ceil(q × n) 个。 */
const percentile = (sorted: number[], q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];

/**
 * 切图耗时计时器（环形缓冲）。start 到 painted 记一次；新的 start 取代还没配对的 start，
 * 没有 start 的 painted 不记。时钟由调用方注入，不依赖 DOM。
 */
export function createSwitchTimer(now: () => number): SwitchTimer {
  const samples: number[] = [];
  let next = 0;
  let pending: number | null = null;
  return {
    markSwitchStart() {
      pending = now();
    },
    markSwitchPainted() {
      if (pending === null) return;
      const d = now() - pending;
      pending = null;
      if (samples.length < CAPACITY) samples.push(d);
      else samples[next] = d;
      next = (next + 1) % CAPACITY;
    },
    switchStats() {
      if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
      };
    },
  };
}

const timer = createSwitchTimer(() => performance.now());

/** 按键或点击切图时。 */
export function markSwitchStart(): void {
  timer.markSwitchStart();
}
/** 新图换上后的下一帧。 */
export function markSwitchPainted(): void {
  timer.markSwitchPainted();
}
/** 最近 200 次切图耗时（毫秒）。 */
export function switchStats(): SwitchStats {
  return timer.switchStats();
}
