// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbsWant } from "../../ipc/api";
import type { ImageList } from "../../lib/deriveList";
import { markSwitchPainted, switchStats } from "../../lib/perfMarks";
import { useCatalog } from "../../stores/catalog";
import { topView, useNav } from "../../stores/nav";
import { useThumbs } from "../../stores/thumbs";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import Filmstrip from "./Filmstrip";

vi.mock("../../ipc/api", () => ({ thumbsWant: vi.fn() }));

let restore: (() => void)[] = [];
let viewWidth = 600;
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
  viewWidth = 600;
  stubProp(Element.prototype, "clientWidth", { get: () => viewWidth });
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

  it("已有当前版本、档位不低于 320 的缩略图的项不再登记", async () => {
    useCatalog.getState().begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: [1, 2, 3, 4, 5].map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
    });
    useThumbs.getState().markReady([{ id: 1, v: "1-1" }], 640);   // 当前版本的 640：跳过
    useThumbs.getState().markReady([{ id: 2, v: "0-9" }], 640);   // 旧版本：仍要
    useThumbs.getState().markReady([{ id: 4, v: "1-1" }], 320);   // 当前版本的 320：跳过
    render(<Filmstrip list={flat(5)} current={1} />);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(thumbsWant).toHaveBeenCalledWith("strip", [2, 3, 5], 320);
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
  it("点击当前项不做事：不标记切图开始，免得与之后无关的绘制配对", () => {
    act(() => useNav.getState().openSingle(1));
    const { container } = render(<Filmstrip list={flat(20)} current={1} />);
    const before = switchStats().count;
    fireEvent.click(container.querySelector('.strip-item[data-id="1"]')!);
    markSwitchPainted();
    expect(switchStats().count).toBe(before);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 1 });
  });

  it("点击与实际显示的那张比较，而不是视图栈里的 id", () => {
    act(() => useNav.getState().openSingle(5));
    // 画面上显示的是 1（视图栈尚未跟上）：点 1 不算切图，也不改视图栈
    const { container } = render(<Filmstrip list={flat(20)} current={1} />);
    const before = switchStats().count;
    fireEvent.click(container.querySelector('.strip-item[data-id="1"]')!);
    markSwitchPainted();
    expect(switchStats().count).toBe(before);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 5 });
  });

  describe("保持当前项可见，但不与用户的滚动较劲", () => {
    /** 渲染后接管滚动区的 scrollLeft，模拟用户把条滚到 5000（当前项 50 在 [2940, 2996) 早已不可见）。 */
    function scrolledAway(list: ImageList) {
      const view = render(<Filmstrip list={list} current={50} />);
      const scroller = view.container.querySelector<HTMLElement>(".strip-scroller")!;
      const pos = { left: 0 };
      Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => pos.left, set: (v) => (pos.left = v) });
      pos.left = 5000;
      return { ...view, pos };
    }

    it("列表刷新但内容不变（新对象）时不动 scrollLeft", () => {
      const { rerender, pos } = scrolledAway(flat(200));
      rerender(<Filmstrip list={flat(200)} current={50} />);
      expect(pos.left).toBe(5000);
    });

    it("当前项前面插入了项（它的位置变了）时滚到让它可见", () => {
      const { rerender, pos } = scrolledAway(flat(200));
      // 在最前面插入 0 与 -1：当前项 50 移到第 51 项，left = 51 × 60 = 3060
      const ids = [-1, 0, ...flat(200).ids];
      rerender(<Filmstrip list={{ ids, groups: [{ dir: "", start: 0, count: 202, total: 202 }] }} current={50} />);
      expect(pos.left).toBe(3060 + 28 - 300);
    });

    it("视口变窄前当前项完整可见：变窄后仍让它可见", () => {
      let notify: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) { notify = cb; }
          observe() {}
          disconnect() {}
        },
      );
      try {
        const { pos } = scrolledAway(flat(200));
        // 当前项 50 在 [2940, 2996)，视口 [2700, 3300) 里完整可见
        pos.left = 2700;
        // 详细信息面板展开，条变窄到 200：[2700, 2900) 里看不见它了
        viewWidth = 200;
        act(() => notify!());
        expect(pos.left).toBe(2940 + 28 - 100);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("只是视口宽度变化时不动 scrollLeft", () => {
      let notify: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) { notify = cb; }
          observe() {}
          disconnect() {}
        },
      );
      try {
        const { pos } = scrolledAway(flat(200));
        viewWidth = 800;
        act(() => notify!());
        expect(pos.left).toBe(5000);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe("Filmstrip 对比角标", () => {
  it("只有在篮内的项显示琥珀角标", () => {
    useBasket.setState({ order: [2], items: new Map([[2, {} as never]]), missing: new Set() });
    const { container } = render(<Filmstrip list={flat(5)} current={1} />);
    const badges = container.querySelectorAll(".strip-basket-badge");
    expect(badges.length).toBe(1);
    expect(badges[0].closest<HTMLElement>(".strip-item")!.dataset.id).toBe("2");
    expect(badges[0].getAttribute("aria-label")).toBe(t("basket.inBasket"));
  });
});
