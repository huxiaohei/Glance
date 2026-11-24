// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { dragOut } from "../ipc/api";
import type { DragEnd } from "../ipc/types";
import { useToast } from "../stores/toast";
import { isOwnDragActive, startNativeDrag } from "./nativeDrag";

vi.mock("../ipc/api");

describe("startNativeDrag", () => {
  let onEnd: ((r: DragEnd) => void) | null = null;
  beforeEach(() => {
    // 上一条用例可能留下“进行中”：用一次 pointerdown 清掉
    window.dispatchEvent(new Event("pointerdown"));
    onEnd = null;
    vi.mocked(dragOut).mockReset();
    vi.mocked(dragOut).mockImplementation((_ids, cb) => {
      onEnd = cb;
      return Promise.resolve();
    });
    useToast.setState({ current: null });
  });

  it("调用 dragOut(ids, 回调)，期间 isOwnDragActive 为真", async () => {
    startNativeDrag([3, 1]);
    expect(dragOut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dragOut).mock.calls[0][0]).toEqual([3, 1]);
    expect(typeof vi.mocked(dragOut).mock.calls[0][1]).toBe("function");
    expect(isOwnDragActive()).toBe(true);
    await Promise.resolve(); // macOS：发起后就兑现，仍在进行中
    expect(isOwnDragActive()).toBe(true);
  });

  it("回调到来后 isOwnDragActive 为假", async () => {
    startNativeDrag([1]);
    await Promise.resolve();
    onEnd!("dropped");
    expect(isOwnDragActive()).toBe(false);
  });

  it("回调先于兑现到来（Windows）：isOwnDragActive 为假，兑现后仍为假", async () => {
    let resolve!: () => void;
    vi.mocked(dragOut).mockImplementation((_ids, cb) => {
      onEnd = cb;
      return new Promise<void>((r) => { resolve = r; });
    });
    startNativeDrag([1]);
    onEnd!("cancelled");
    expect(isOwnDragActive()).toBe(false);
    resolve();
    await Promise.resolve();
    expect(isOwnDragActive()).toBe(false);
  });

  it("dragOut 拒绝 'notFound'：出提示条，isOwnDragActive 为假", async () => {
    vi.mocked(dragOut).mockRejectedValue("notFound");
    startNativeDrag([1]);
    await vi.waitFor(() => expect(isOwnDragActive()).toBe(false));
    expect(useToast.getState().current?.text).toBe(t("fs.err.notFound"));
  });

  it("认不出的错误码按 other 提示", async () => {
    vi.mocked(dragOut).mockRejectedValue(new Error("boom"));
    startNativeDrag([1]);
    await vi.waitFor(() => expect(useToast.getState().current?.text).toBe(t("fs.err.other")));
    expect(isOwnDragActive()).toBe(false);
  });

  it("没等到回调但页面收到 pointerdown：isOwnDragActive 为假", async () => {
    startNativeDrag([1]);
    await Promise.resolve();
    window.dispatchEvent(new Event("pointerdown"));
    expect(isOwnDragActive()).toBe(false);
  });

  it("上一次拖拽迟到的回调不清掉这一次", async () => {
    startNativeDrag([1]);
    const first = onEnd!;
    window.dispatchEvent(new Event("pointerdown"));
    startNativeDrag([2]);
    first("dropped");
    expect(isOwnDragActive()).toBe(true);
    onEnd!("dropped");
    expect(isOwnDragActive()).toBe(false);
  });

  it("ids 为空：不调用", () => {
    startNativeDrag([]);
    expect(dragOut).not.toHaveBeenCalled();
    expect(isOwnDragActive()).toBe(false);
  });
});
