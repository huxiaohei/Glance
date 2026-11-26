import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewResult } from "../ipc/types";
import { createPreviewScheduler } from "./editPreview";

const res = (rev: number): PreviewResult => ({ rev, bytes: 1, approx: false, format: "jpeg", width: 1, height: 1 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createPreviewScheduler", () => {
  it("sends_proxy_immediately_and_full_after_200ms", async () => {
    const run = vi.fn(async (rev: number) => res(rev));
    const s = createPreviewScheduler({ run, onResult: () => {} });
    s.change();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(1, false);
    vi.advanceTimersByTime(199);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(2, true);
    s.dispose();
  });

  it("proxy_false_sends_only_full_after_delay", () => {
    const run = vi.fn(async (rev: number, _full: boolean) => res(rev));
    const s = createPreviewScheduler({ run, onResult: () => {}, proxy: () => false });
    s.change();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(1, true);
    s.dispose();
  });

  it("full_restarts_on_each_change", () => {
    const run = vi.fn(async (rev: number, _full: boolean) => res(rev));
    const s = createPreviewScheduler({ run, onResult: () => {} });
    s.change();
    vi.advanceTimersByTime(150);
    s.change();
    vi.advanceTimersByTime(150);
    expect(run.mock.calls.map((c) => c[1])).toEqual([false, false]);
    vi.advanceTimersByTime(50);
    expect(run.mock.calls).toEqual([[1, false], [2, false], [3, true]]);
    s.dispose();
  });

  it("delivers_intermediate_results_during_continuous_change", async () => {
    // 拖动中：请求不断发出，回包按序到达但都比最新的请求旧，只要比已显示的新就交出去。
    const pending = new Map<number, (r: PreviewResult | null) => void>();
    const run = vi.fn((rev: number) => new Promise<PreviewResult | null>((r) => pending.set(rev, r)));
    const shown: number[] = [];
    const s = createPreviewScheduler({ run, onResult: (r) => shown.push(r.rev) });
    s.change(); // rev 1
    s.change(); // rev 2
    pending.get(1)!(res(1));
    await vi.advanceTimersByTimeAsync(0);
    s.change(); // rev 3
    s.change(); // rev 4
    pending.get(2)!(null); // 未开始即被顶掉
    pending.get(3)!(res(3));
    await vi.advanceTimersByTimeAsync(0);
    s.change(); // rev 5
    pending.get(4)!(res(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([1, 3, 4]);
    s.dispose();
  });

  it("drops_stale_preview", async () => {
    const pending = new Map<number, (r: PreviewResult | null) => void>();
    const run = vi.fn((rev: number) => new Promise<PreviewResult | null>((r) => pending.set(rev, r)));
    const shown: number[] = [];
    const s = createPreviewScheduler({ run, onResult: (r) => shown.push(r.rev) });
    s.change(); // rev 1
    s.change(); // rev 2
    s.change(); // rev 3
    pending.get(3)!(res(3));
    await vi.advanceTimersByTimeAsync(0);
    pending.get(2)!(res(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([3]);
    s.dispose();
  });

  it("null_results_ignored", async () => {
    const run = vi.fn(async () => null);
    const onResult = vi.fn();
    const s = createPreviewScheduler({ run, onResult });
    s.change();
    await vi.advanceTimersByTimeAsync(300);
    expect(onResult).not.toHaveBeenCalled();
    s.dispose();
  });

  it("dispose_stops_timer_and_results", async () => {
    const run = vi.fn(async (rev: number) => res(rev));
    const onResult = vi.fn();
    const s = createPreviewScheduler({ run, onResult });
    s.change();
    s.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("reports_error_of_latest_request_only", async () => {
    const run = vi.fn(async (rev: number) => {
      throw rev === 1 ? "old" : "encode";
    });
    const onResult = vi.fn();
    const onError = vi.fn();
    const s = createPreviewScheduler({ run, onResult, onError });
    s.change(); // rev 1（代理）
    s.change(); // rev 2（代理），rev 1 的失败已被取代
    await vi.advanceTimersByTimeAsync(0);
    expect(onError.mock.calls).toEqual([["encode"]]);
    s.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("cut_drops_results_and_errors_of_requests_already_sent", async () => {
    const pending = new Map<number, { ok(r: PreviewResult | null): void; fail(e: unknown): void }>();
    const run = vi.fn(
      (rev: number) => new Promise<PreviewResult | null>((ok, fail) => pending.set(rev, { ok, fail })),
    );
    const shown: number[] = [];
    const onError = vi.fn();
    const s = createPreviewScheduler({ run, onResult: (r) => shown.push(r.rev), onError, proxy: () => false });
    s.change();
    vi.advanceTimersByTime(200); // rev 1（全尺寸）在途
    s.cut();
    s.change();
    pending.get(1)!.ok(res(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([]);
    // 新请求发出前旧请求的失败也不报
    s.cut();
    vi.advanceTimersByTime(200); // rev 2
    s.cut();
    pending.get(2)!.fail("encode");
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    s.change();
    vi.advanceTimersByTime(200); // rev 3
    pending.get(3)!.ok(res(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([3]);
    s.dispose();
  });
});
