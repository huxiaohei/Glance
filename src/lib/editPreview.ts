import type { PreviewResult } from "../ipc/types";

export interface PreviewSchedulerOpts {
  /** 发一次预览请求；被取代或会话已关时为 null。 */
  run(rev: number, full: boolean): Promise<PreviewResult | null>;
  onResult(r: PreviewResult): void;
  /** 最新一次请求失败（错误码原样交出）；被更新的请求取代的失败不报。 */
  onError?(err: unknown): void;
  delayMs?: number;
  /** 是否先发代理图；返回 false 时 change() 只排全尺寸（裁剪页：预览不依赖代理）。 */
  proxy?: () => boolean;
}

/**
 * 两段式预览：每次参数变化立即请求代理图（full=false），停手 delayMs 后再请求全尺寸。
 * rev 严格递增；回包只有 rev 不小于已显示的才交出去，迟到的旧结果丢弃。
 * cut() 之后，之前发出的请求的结果与失败一概丢弃（换页时上一页还在途的请求不再上画面）。
 */
export function createPreviewScheduler(opts: PreviewSchedulerOpts): { change(): void; cut(): void; dispose(): void } {
  const delay = opts.delayMs ?? 200;
  let rev = 0;
  let shown = 0;
  /** 小于它的 rev 都已被 cut() 作废 */
  let floor = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const send = (full: boolean) => {
    rev += 1;
    const mine = rev;
    opts.run(mine, full).then(
      (r) => {
        if (disposed || r === null || r.rev < shown || r.rev < floor) return;
        shown = r.rev;
        opts.onResult(r);
      },
      (err) => {
        if (disposed || mine !== rev || mine < floor) return;
        opts.onError?.(err);
      },
    );
  };

  return {
    change() {
      if (disposed) return;
      if (opts.proxy?.() !== false) send(false);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send(true);
      }, delay);
    },
    cut() {
      floor = rev + 1;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
