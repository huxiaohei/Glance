// @vitest-environment jsdom
import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdle } from "./useIdle";

let el: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  el = document.createElement("div");
  document.body.appendChild(el);
});
afterEach(() => {
  vi.useRealTimers();
  el.remove();
});

const move = (x: number, y: number) => act(() => void fireEvent.pointerMove(el, { clientX: x, clientY: y }));

describe("useIdle", () => {
  it("静止 2 秒后为 true，移动鼠标立刻回到 false 并重新计时", () => {
    const { result } = renderHook(() => useIdle(el, 2000, false));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    move(5, 5);
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("按下、滚轮、按键都算活动", () => {
    const { result } = renderHook(() => useIdle(el, 2000, false));
    for (const fire of [
      () => fireEvent.pointerDown(el),
      () => fireEvent.wheel(el),
      () => fireEvent.keyDown(document.body, { key: "a" }),
    ]) {
      act(() => void vi.advanceTimersByTime(2000));
      expect(result.current).toBe(true);
      act(() => void fire());
      expect(result.current).toBe(false);
    }
  });

  it("位置没变的 pointermove 不算活动", () => {
    const { result } = renderHook(() => useIdle(el, 2000, false));
    move(5, 5);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(true);
    move(5, 5);
    expect(result.current).toBe(true);
    move(6, 5);
    expect(result.current).toBe(false);
  });

  it("pinned 时不进入静止状态，解除后重新计时", () => {
    const { result, rerender } = renderHook(({ p }) => useIdle(el, 2000, p), { initialProps: { p: true } });
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current).toBe(false);
    rerender({ p: false });
    act(() => void vi.advanceTimersByTime(1999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("子元素原生拦下 pointerdown（箭头区域）时按下仍算活动", () => {
    const child = document.createElement("div");
    el.appendChild(child);
    child.addEventListener("pointerdown", (e) => e.stopPropagation());
    const { result } = renderHook(() => useIdle(el, 2000, false));
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(true);
    act(() => void fireEvent.pointerDown(child));
    expect(result.current).toBe(false);
  });

  it("pinned 变化不重置上次的指针位置：面板关上后同位置的合成移动不算活动", () => {
    const { result, rerender } = renderHook(({ p }) => useIdle(el, 2000, p), { initialProps: { p: false } });
    move(5, 5);
    rerender({ p: true });
    rerender({ p: false });
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(true);
    move(5, 5);
    expect(result.current).toBe(true);
  });

  it("卸载时清掉定时器和监听", () => {
    const { unmount } = renderHook(() => useIdle(el, 2000, false));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
