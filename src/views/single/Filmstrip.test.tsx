// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbsWant } from "../../ipc/api";
import type { ImageList } from "../../lib/deriveList";
import { markSwitchPainted, switchStats } from "../../lib/perfMarks";
import { useCatalog } from "../../stores/catalog";
import { topView, useNav } from "../../stores/nav";
import { useThumbs } from "../../stores/thumbs";
import Filmstrip from "./Filmstrip";

vi.mock("../../ipc/api", () => ({ thumbsWant: vi.fn() }));

let restore: (() => void)[] = [];
const stubProp = (proto: object, prop: string, desc: PropertyDescriptor) => {
  const old = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, ...desc });
  restore.push(() => (old ? Object.defineProperty(proto, prop, old) : delete (proto as Record<string, unknown>)[prop]));
};

const flat = (n: number): ImageList => ({
  ids: Array.from({ length: n }, (_, i) => i + 1),
  groups: [{ dir: "", start: 0, count: n, total: n }],
});
const shownIds = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".strip-item")].map((e) => Number(e.dataset.id));
const currentId = (c: HTMLElement) => Number(c.querySelector<HTMLElement>(".strip-current")?.dataset.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(thumbsWant).mockResolvedValue([]);
  // 视口宽 600：一屏放得下 10 项
  stubProp(Element.prototype, "clientWidth", { get: () => 600 });
  useThumbs.getState().reset();
  useCatalog.getState().reset();
  useNav.getState().reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const r of restore.reverse()) r();
  restore = [];
});

describe("Filmstrip", () => {
  it("1 万张时只渲染可见项（含左右各一屏）", () => {
    const { container } = render(<Filmstrip list={flat(10000)} current={1} />);
    const ids = shownIds(container);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(40);
    expect(ids).toContain(1);
  });

  it("当前项高亮；切图后高亮跟随", () => {
    const list = flat(10000);
    const { container, rerender } = render(<Filmstrip list={list} current={1} />);
    expect(currentId(container)).toBe(1);
    expect(container.querySelectorAll(".strip-current")).toHaveLength(1);
    // 跳到很远的一张：条滚过去，那一项在 DOM 里并且高亮
    rerender(<Filmstrip list={list} current={5000} />);
    expect(currentId(container)).toBe(5000);
    expect(shownIds(container)).not.toContain(1);
  });

  it("点击某项跳到那张图", () => {
    const list = flat(20);
    act(() => useNav.getState().openSingle(1));
    const before = switchStats().count;
    const { container } = render(<Filmstrip list={list} current={1} />);
    fireEvent.click(container.querySelector('.strip-item[data-id="3"]')!);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    // 计入切图耗时：点击标记了开始，画出时配对成一次样本
    markSwitchPainted();
    expect(switchStats().count).toBe(before + 1);
  });

  it("以 strip 为消费者登记可见项，跳过已损坏的；卸载时登记空集合", async () => {
    useThumbs.setState({ broken: new Set([2]) });
    vi.mocked(thumbsWant).mockResolvedValue([{ id: 1, v: "5-10" }]);
    const { unmount } = render(<Filmstrip list={flat(5)} current={1} />);
    expect(thumbsWant).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(thumbsWant).toHaveBeenCalledWith("strip", [1, 3, 4, 5], 320);
    expect(useThumbs.getState().ready.get(1)).toEqual({ tier: 320, v: "5-10" });
    unmount();
    expect(thumbsWant).toHaveBeenLastCalledWith("strip", [], 320);
  });

  it("generation 变化时重新登记", async () => {
    const root = (generation: number) => ({ generation, path: "/r", name: "r", recursive: true, focus: null });
    useCatalog.getState().begin(root(1));
    render(<Filmstrip list={flat(5)} current={1} />);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(thumbsWant).toHaveBeenCalledTimes(1);
    act(() => useCatalog.getState().begin(root(2), { keep: true }));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(thumbsWant).toHaveBeenCalledTimes(2);
  });

  it("分组之间画分隔线，第一组前没有", () => {
    const list: ImageList = {
      ids: [1, 2, 3, 4, 5],
      groups: [
        { dir: "a", start: 0, count: 3, total: 3 },
        { dir: "b", start: 3, count: 2, total: 2 },
      ],
    };
    const { container } = render(<Filmstrip list={list} current={1} />);
    expect(container.querySelectorAll(".strip-divider")).toHaveLength(1);
  });

  it("滚轮的纵向量横向滚动条，并阻止默认行为", () => {
    const { container } = render(<Filmstrip list={flat(100)} current={1} />);
    const scroller = container.querySelector<HTMLElement>(".strip-scroller")!;
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => left, set: (v) => (left = v) });
    const ev = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    scroller.dispatchEvent(ev);
    expect(left).toBe(120);
    expect(ev.defaultPrevented).toBe(true);
  });
});
