// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { showToast, useToast, withBusy } from "../../stores/toast";
import Toast from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
  useToast.setState({ current: null });
});
afterEach(() => vi.useRealTimers());

const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("Toast", () => {
  it("5 秒后自动消失", () => {
    render(<Toast />);
    act(() => { showToast({ text: "已移到废纸篓" }); });
    expect(screen.getByRole("status").textContent).toContain("已移到废纸篓");
    tick(4999);
    expect(screen.queryByRole("status")).not.toBeNull();
    tick(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("新的提示替换旧的，旧提示的计时不会关掉新的", () => {
    render(<Toast />);
    act(() => { showToast({ text: "旧" }); });
    tick(3000);
    act(() => { showToast({ text: "新" }); });
    tick(3000);
    expect(screen.getByRole("status").textContent).toContain("新");
    tick(2000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("悬停期间不消失，离开后重新计时", () => {
    render(<Toast />);
    act(() => { showToast({ text: "x" }); });
    const el = screen.getByRole("status");
    tick(2000);
    fireEvent.pointerEnter(el);
    tick(20000);
    expect(screen.queryByRole("status")).not.toBeNull();
    fireEvent.pointerLeave(el);
    tick(4999);
    expect(screen.queryByRole("status")).not.toBeNull();
    tick(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("详情展开期间不消失，收起后重新计时", () => {
    render(<Toast />);
    act(() => { showToast({ text: "x", details: ["a.jpg：失败", "b.jpg：失败"] }); });
    expect(screen.queryByText("a.jpg：失败")).toBeNull();
    const toggle = screen.getByRole("button", { name: t("toast.details") });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("a.jpg：失败")).toBeTruthy();
    expect(screen.getByText("b.jpg：失败")).toBeTruthy();
    tick(20000);
    expect(screen.queryByRole("status")).not.toBeNull();
    fireEvent.click(toggle);
    tick(5000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("点击动作后执行并关闭；动作里显示的新提示保留", () => {
    const run = vi.fn(() => { showToast({ text: "已撤销" }); });
    render(<Toast />);
    act(() => { showToast({ text: "已移动", actions: [{ label: "撤销", run }] }); });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("已撤销");
    expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("点击动作后关闭", () => {
    render(<Toast />);
    act(() => { showToast({ text: "已移动", actions: [{ label: "撤销", run: () => {} }] }); });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("动作抛错时提示照样关闭", () => {
    render(<Toast />);
    act(() => { showToast({ text: "已移动", actions: [{ label: "撤销", run: () => { throw new Error("boom"); } }] }); });
    const onError = vi.fn((e: ErrorEvent) => e.preventDefault());
    window.addEventListener("error", onError);
    try {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("关闭按钮关闭提示", () => {
    render(<Toast />);
    act(() => { showToast({ text: "x" }); });
    fireEvent.click(screen.getByRole("button", { name: t("toast.close") }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("busy 提示不自动消失，没有关闭按钮", () => {
    render(<Toast />);
    act(() => { showToast({ text: "处理中", busy: true }); });
    tick(60000);
    expect(screen.getByRole("status").textContent).toContain("处理中");
    expect(screen.queryByRole("button", { name: t("toast.close") })).toBeNull();
  });

  it("withBusy 显示的提示在操作结束后消失", async () => {
    render(<Toast />);
    let done!: () => void;
    const p = withBusy("处理中", new Promise<void>((r) => (done = r)));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByRole("status")).not.toBeNull();
    await act(async () => { done(); await p; });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
