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
});
