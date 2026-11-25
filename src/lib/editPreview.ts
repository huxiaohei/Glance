import type { PreviewResult } from "../ipc/types";

export interface PreviewSchedulerOpts {
  /** 发一次预览请求；被取代或会话已关时为 null。 */
  run(rev: number, full: boolean): Promise<PreviewResult | null>;
  onResult(r: PreviewResult): void;
  delayMs?: number;
}

/**
 * 两段式预览：每次参数变化立即请求代理图（full=false），停手 delayMs 后再请求全尺寸。
 * rev 严格递增；回包只有 rev 不小于已显示的才交出去，迟到的旧结果丢弃。
 */
export function createPreviewScheduler(opts: PreviewSchedulerOpts): { change(): void; dispose(): void } {
  const delay = opts.delayMs ?? 200;
  let rev = 0;
  let shown = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const send = (full: boolean) => {
    rev += 1;
    opts.run(rev, full).then(
      (r) => {
        if (disposed || r === null || r.rev < shown) return;
        shown = r.rev;
        opts.onResult(r);
      },
      () => {},
    );
  };

  return {
    change() {
      if (disposed) return;
      send(false);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send(true);
      }, delay);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
