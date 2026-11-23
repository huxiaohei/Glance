import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, showToast, useToast, withBusy } from "./toast";

beforeEach(() => {
  vi.useFakeTimers();
  useToast.setState({ current: null });
});
afterEach(() => vi.useRealTimers());

describe("toast store", () => {
  it("showToast 替换当前提示，key 递增", () => {
    const a = showToast({ text: "a" });
    const b = showToast({ text: "b" });
    expect(b).toBeGreaterThan(a);
    expect(useToast.getState().current?.text).toBe("b");
    expect(useToast.getState().current?.key).toBe(b);
  });

  it("dismissToast(key) 不会关掉后来的提示", () => {
    const a = showToast({ text: "a" });
    showToast({ text: "b" });
    dismissToast(a);
    expect(useToast.getState().current?.text).toBe("b");
    dismissToast();
    expect(useToast.getState().current).toBeNull();
  });

  it("withBusy：0.5 秒内完成不显示任何提示", async () => {
    let done!: (v: number) => void;
    const p = withBusy("忙", new Promise<number>((r) => (done = r)));
    await vi.advanceTimersByTimeAsync(499);
    done(7);
    await expect(p).resolves.toBe(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useToast.getState().current).toBeNull();
  });

  it("withBusy：超过 0.5 秒显示，结束后关闭", async () => {
    let done!: (v: number) => void;
    const p = withBusy("忙", new Promise<number>((r) => (done = r)));
    await vi.advanceTimersByTimeAsync(500);
    expect(useToast.getState().current).toMatchObject({ text: "忙", busy: true });
    done(1);
    await p;
    expect(useToast.getState().current).toBeNull();
  });

  it("withBusy：失败时同样关闭并抛出错误；不关掉后来的提示", async () => {
    let fail!: (e: Error) => void;
    const p = withBusy("忙", new Promise<number>((_, r) => (fail = r)));
    await vi.advanceTimersByTimeAsync(600);
    showToast({ text: "新的" });
    fail(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(useToast.getState().current?.text).toBe("新的");
  });
});
