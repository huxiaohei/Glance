// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showImageMenu } from "../../app/contextMenu";
import { setLanguage } from "../../i18n";
import * as api from "../../ipc/api";
import type { BasketEntry, FileId } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { FIT_VIEWPORT } from "../../lib/compareViewport";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi } from "../../stores/compareUi";
import { topView, useNav } from "../../stores/nav";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useThumbs } from "../../stores/thumbs";
import { useToast } from "../../stores/toast";
import CompareView from "./CompareView";
import { registerCompareCommands } from "./compareCommands";

vi.mock("../../ipc/api");
vi.mock("../../app/contextMenu", () => ({ showImageMenu: vi.fn(async () => {}) }));

const item = (id: FileId, name: string, width: number, height: number): BasketItem => ({
  id, name, dirName: "魏国", size: 100 + id, mtimeMs: 1, width, height,
});
const ITEMS = [item(1, "关羽.png", 1024, 1536), item(2, "张飞.png", 1024, 1536), item(3, "马超.png", 832, 1216)];
const entry = (it: BasketItem): BasketEntry => ({
  id: it.id, name: it.name, dirName: it.dirName, size: it.size, mtimeMs: it.mtimeMs, w: it.width!, h: it.height!,
});

function fill(items: BasketItem[]) {
  useBasket.setState({ order: items.map((i) => i.id), items: new Map(items.map((i) => [i.id, i])), missing: new Set() });
}

beforeEach(() => {
  setLanguage("zh-CN");
  useCatalog.getState().reset();
  useNav.getState().reset();
  useNav.getState().openCompare();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, open: false });
  useToast.setState({ current: null });
  useCompareUi.setState({ viewport: FIT_VIEWPORT, perCell: null, focus: null, captions: true, panelOpen: false });
  fill(ITEMS);
  vi.mocked(api.thumbsWant).mockResolvedValue([]);
  vi.mocked(api.settingsSet).mockResolvedValue();
  vi.mocked(api.basketCheck).mockImplementation((ids) =>
    Promise.resolve(ids.map((id) => entry(ITEMS.find((i) => i.id === id)!))),
  );
});
afterEach(() => vi.clearAllMocks());

const cells = (c: HTMLElement) => c.querySelectorAll(".compare-cell");
const cell = (c: HTMLElement, id: FileId) => c.querySelector<HTMLElement>(`.compare-cell[data-id="${id}"]`)!;

/** 让 jsdom 量出 200×300 的图片区。返回还原函数。 */
function fakeBox(): () => void {
  const descs = (["clientWidth", "clientHeight"] as const).map((p) => [p, Object.getOwnPropertyDescriptor(Element.prototype, p)!] as const);
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 300 });
  return () => {
    for (const [p, d] of descs) Object.defineProperty(Element.prototype, p, d);
  };
}

/** 手动驱动的 requestAnimationFrame。 */
function fakeRaf(): { flush(): void; restore(): void } {
  let frames: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return {
    flush() {
      const run = frames;
      frames = [];
      run.forEach((cb) => cb(0));
    },
    restore() {
      raf.mockRestore();
      caf.mockRestore();
    },
  };
}

describe("CompareView", () => {
  it("篮内 3 张 → 3 格，标题“对比 · 3 张”", async () => {
    const { container } = render(<CompareView />);
    expect(cells(container)).toHaveLength(3);
    expect(screen.getByText("对比 · 3 张")).toBeTruthy();
    await waitFor(() => expect(api.basketCheck).toHaveBeenCalledWith([1, 2, 3]));
  });

  it("交换让焦点格换了位置后重新滚进视口", () => {
    const spy = vi.fn();
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = spy;
    try {
      useCompareUi.setState({ focus: 1 });
      render(<CompareView />);
      spy.mockClear();
      act(() => useBasket.getState().swap(1, 2));
      expect(useCompareUi.getState().focus).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });

  it("顶栏“添加”切换右侧添加面板，面板与图片墙并排", () => {
    const { container } = render(<CompareView />);
    const add = screen.getByRole("button", { name: "添加" });
    expect(add.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".compare-panel")).toBeNull();
    fireEvent.click(add);
    expect(useCompareUi.getState().panelOpen).toBe(true);
    expect(add.getAttribute("aria-pressed")).toBe("true");
    const panel = container.querySelector(".compare-panel")!;
    expect(panel.parentElement).toBe(container.querySelector(".compare-scroller")!.parentElement);
    fireEvent.click(add);
    expect(container.querySelector(".compare-panel")).toBeNull();
    expect(api.thumbsWant).toHaveBeenLastCalledWith("comparePanel", [], 320);
  });

  it("在图片墙上按下把焦点区域还给墙", () => {
    useCompareUi.setState({ panelOpen: true });
    const { container } = render(<CompareView />);
    act(() => useCompareUi.setState({ focusArea: "panel" }));
    fireEvent.pointerDown(container.querySelector(".compare-scroller")!);
    expect(useCompareUi.getState().focusArea).toBe("wall");
  });

  it("列数取自设置 compareColumns", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, compareColumns: 3 } });
    const { container } = render(<CompareView />);
    const grid = container.querySelector<HTMLElement>(".compare-grid")!;
    expect(grid.style.gridTemplateColumns).toMatch(/^repeat\(3,/);
  });

  it("改每排张数写回设置", async () => {
    render(<CompareView />);
    fireEvent.change(screen.getByLabelText("每排张数"), { target: { value: "6" } });
    expect(useSettings.getState().settings.compareColumns).toBe(6);
    await waitFor(() => expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ compareColumns: 6 })));
  });

  it("尺寸与多数不同的那一格说明带 is-odd", () => {
    const { container } = render(<CompareView />);
    const odd = [...container.querySelectorAll(".compare-size.is-odd")].map((e) => e.textContent);
    expect(odd).toEqual(["832×1216"]);
    expect(container.querySelector('[data-id="3"] .compare-caption')!.textContent).toBe("马超.png · 832×1216");
  });

  it("basketCheck 报某张缺失 → 该格显示“文件已不在”，并出现提示条，点“全部移出”移出缺失的", async () => {
    vi.mocked(api.basketCheck).mockResolvedValue([entry(ITEMS[0]), null, entry(ITEMS[2])]);
    const { container } = render(<CompareView />);
    await waitFor(() => expect(useToast.getState().current?.text).toBe("有 1 张已不存在"));
    expect(container.querySelector('[data-id="2"]')!.textContent).toContain("文件已不在");
    expect(container.querySelector('[data-id="1"]')!.textContent).not.toContain("文件已不在");
    const action = useToast.getState().current!.actions!.find((a) => a.label === "全部移出")!;
    act(() => action.run());
    expect(useBasket.getState().order).toEqual([1, 3]);
    // 全部移出同样可撤销
    const removed = useToast.getState().current!;
    expect(removed.text).toBe("已移出对比");
    act(() => removed.actions!.find((a) => a.label === "撤销")!.run());
    expect(useBasket.getState().order).toEqual([1, 2, 3]);
  });

  it("都在时不出提示条", async () => {
    render(<CompareView />);
    await waitFor(() => expect(api.basketCheck).toHaveBeenCalled());
    await act(async () => {});
    expect(useToast.getState().current).toBeNull();
  });

  it("改背景 → settingsSet 收到新值，根节点 data-bg 改变", async () => {
    const { container } = render(<CompareView />);
    const root = container.querySelector<HTMLElement>(".compare-view")!;
    expect(root.dataset.bg).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "棋盘格" }));
    expect(root.dataset.bg).toBe("checker");
    await waitFor(() =>
      expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ compareBackground: "checker" })),
    );
  });

  it("关掉说明后说明消失", () => {
    const { container } = render(<CompareView />);
    expect(container.querySelectorAll(".compare-caption")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "说明" }));
    expect(container.querySelectorAll(".compare-caption")).toHaveLength(0);
  });

  it("返回按钮回到进入前的视图", () => {
    render(<CompareView />);
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(topView().kind).toBe("grid");
  });

  it("清空：篮子清空并返回，提示条带撤销，撤销恢复篮子但不重新进入", () => {
    render(<CompareView />);
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(useBasket.getState().order).toEqual([]);
    expect(topView().kind).toBe("grid");
    const toast = useToast.getState().current!;
    expect(toast.text).toBe("已清空对比篮");
    act(() => toast.actions!.find((a) => a.label === "撤销")!.run());
    expect(useBasket.getState().order).toEqual([1, 2, 3]);
    expect(topView().kind).toBe("grid");
  });

  it("挂载即一次进入：按 compareSyncOnEnter 设同步，视口回到适应，焦点为第一张", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, compareSyncOnEnter: false } });
    useCompareUi.setState({ viewport: { scale: { kind: "rel", k: 3 }, u: 0, v: 0 }, focus: 9 });
    render(<CompareView />);
    const s = useCompareUi.getState();
    expect(s.perCell).toEqual(new Map());
    expect(s.viewport).toEqual(FIT_VIEWPORT);
    expect(s.focus).toBe(1);
  });

  it("底部提示条：未放大时提示同步缩放、同步开关、添加图片；放大后换成平移；关掉设置后不出现", () => {
    const off = registerCompareCommands();
    try {
      const { container } = render(<CompareView />);
      const bar = () => container.querySelector(".compare-hintbar .key-hints");
      expect(bar()!.textContent).toContain("同步缩放");
      expect(bar()!.textContent).toContain("同步开关");
      expect(bar()!.textContent).toContain("添加图片");
      expect(bar()!.textContent).not.toContain("平移");
      act(() => useCompareUi.setState({ viewport: { scale: { kind: "rel", k: 2 }, u: 0.5, v: 0.5 } }));
      expect(bar()!.textContent).toContain("平移");
      expect(bar()!.textContent).not.toContain("移出");
      act(() => useCompareUi.setState({ panelOpen: true, focusArea: "panel" }));
      expect(bar()!.textContent).toContain("添加 / 移出");
      expect(bar()!.textContent).toContain("回到图片");
      expect(bar()!.textContent).not.toContain("同步缩放");
      act(() => useCompareUi.setState({ panelOpen: false, focusArea: "wall" }));
      act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, showKeyHints: false } }));
      expect(container.querySelector(".compare-hintbar")).toBeNull();
    } finally {
      off();
    }
  });

  it("同步关时任一格放大也算放大", () => {
    const off = registerCompareCommands();
    try {
      const { container } = render(<CompareView />);
      act(() => useCompareUi.setState({ perCell: new Map([[2, { scale: { kind: "px", s: 1 }, u: 0.5, v: 0.5 }]]) }));
      expect(container.querySelector(".compare-hintbar")!.textContent).toContain("平移");
      expect(container.querySelector(".compare-hintbar .key-hint-text")!.textContent).toBe("缩放");
    } finally {
      off();
    }
  });

  it("同步开关切换 perCell", () => {
    render(<CompareView />);
    const sync = screen.getByRole("switch", { name: "同步缩放" }) as HTMLInputElement;
    expect(sync.checked).toBe(true);
    fireEvent.click(sync);
    expect(useCompareUi.getState().perCell).toEqual(new Map());
    expect(sync.checked).toBe(false);
  });

  it("隐藏时（单张视图盖在上面）只隐藏不卸载", () => {
    const { container, rerender } = render(<CompareView />);
    rerender(<CompareView hidden />);
    const root = container.querySelector<HTMLElement>(".compare-view")!;
    expect(root.classList.contains("compare-hidden")).toBe(true);
    expect(cells(container)).toHaveLength(3);
  });

  describe("对比篮来源的单张视图里移出（模拟 SingleView：篮内移出后列表变化，空了就 back）", () => {
    /** 与 App 相同：对比在栈里就挂着，其上有单张视图时隐藏。 */
    function Host() {
      const top = useNav((s) => s.stack[s.stack.length - 1].kind);
      return <CompareView hidden={top !== "compare"} />;
    }

    it("移空篮子后单张视图退回，对比视图也随之退回进入前的视图", () => {
      fill([ITEMS[0]]);
      render(<Host />);
      act(() => useNav.getState().openSingle(1, "basket"));
      act(() => {
        useBasket.getState().toggle([1]);
        useNav.getState().back();
      });
      expect(useBasket.getState().order).toEqual([]);
      expect(topView().kind).toBe("grid");
    });

    it("焦点那张被移出后回到对比：焦点落到后一张（没有则前一张）", () => {
      const { container } = render(<Host />);
      act(() => useCompareUi.getState().setFocus(2));
      act(() => useNav.getState().openSingle(2, "basket"));
      act(() => {
        useBasket.getState().toggle([2]);
        useNav.getState().setCurrent(3);
      });
      act(() => useNav.getState().back());
      expect(useCompareUi.getState().focus).toBe(3);
      expect(cell(container, 3).classList.contains("is-focus")).toBe(true);

      act(() => useNav.getState().openSingle(3, "basket"));
      act(() => {
        useBasket.getState().toggle([3]);
        useNav.getState().setCurrent(1);
      });
      act(() => useNav.getState().back());
      expect(useCompareUi.getState().focus).toBe(1);
    });
  });

  it("量出图片区后每格按视口换算 transform（适应：整张放进 2:3 的格子）", () => {
    const descs = (["clientWidth", "clientHeight"] as const).map((p) => [p, Object.getOwnPropertyDescriptor(Element.prototype, p)!] as const);
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 300 });
    try {
      useThumbs.getState().markReady([{ id: 1, v: "1-101" }], 640);
      const { container } = render(<CompareView />);
      const pic = container.querySelector<HTMLImageElement>('[data-id="1"] .compare-pic')!;
      expect(pic.style.width).toBe("1024px");
      // 300 / 1536 = 0.1953125；jsdom 会把数值与 translate 写法规整
      expect(pic.style.transform).toMatch(/^translate\(0px(, 0px)?\) scale\(0\.1953/);
    } finally {
      for (const [p, d] of descs) Object.defineProperty(Element.prototype, p, d);
    }
  });

  it("单击格子设焦点", () => {
    const { container } = render(<CompareView />);
    fireEvent.click(cell(container, 2).querySelector(".compare-img")!);
    expect(useCompareUi.getState().focus).toBe(2);
    expect(cell(container, 2).classList.contains("is-focus")).toBe(true);
  });

  it("双击格子进入单张视图，来源为对比篮", () => {
    const { container } = render(<CompareView />);
    fireEvent.doubleClick(cell(container, 2).querySelector(".compare-img")!);
    expect(topView()).toEqual({ kind: "single", source: "basket", id: 2 });
  });

  it("双击缺失的格不进入单张视图", () => {
    useBasket.setState({ missing: new Set([2]) });
    vi.mocked(api.basketCheck).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CompareView />);
    fireEvent.doubleClick(cell(container, 2).querySelector(".compare-img")!);
    expect(topView().kind).toBe("compare");
  });

  it("右键格子：先把焦点设到该格再弹菜单", () => {
    const { container } = render(<CompareView />);
    fireEvent.contextMenu(cell(container, 3).querySelector(".compare-img")!);
    expect(useCompareUi.getState().focus).toBe(3);
    expect(showImageMenu).toHaveBeenCalledTimes(1);
  });

  it("格子右上角的移出按钮（缺失的格也有）：移出并出现带撤销的提示条", () => {
    useBasket.setState({ missing: new Set([2]) });
    vi.mocked(api.basketCheck).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CompareView />);
    const buttons = container.querySelectorAll(".compare-remove");
    expect(buttons).toHaveLength(3);
    fireEvent.click(cell(container, 2).querySelector(".compare-remove")!);
    expect(useBasket.getState().order).toEqual([1, 3]);
    const toast = useToast.getState().current!;
    expect(toast.text).toBe("已移出对比");
    act(() => toast.actions![0].run());
    expect(useBasket.getState().order).toEqual([1, 2, 3]);
  });

  it("Ctrl+滚轮：rAF 后格子 transform 改变，store 在 rAF 前未变，停 150 ms 后写回", () => {
    const restore = fakeBox();
    const raf = fakeRaf();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useThumbs.getState().markReady([{ id: 1, v: "1-101" }, { id: 2, v: "1-102" }], 640);
      const { container } = render(<CompareView />);
      const pic1 = cell(container, 1).querySelector<HTMLImageElement>(".compare-pic")!;
      const pic2 = cell(container, 2).querySelector<HTMLImageElement>(".compare-pic")!;
      const before1 = pic1.style.transform;
      const before2 = pic2.style.transform;
      const vp0 = useCompareUi.getState().viewport;
      const notPrevented = fireEvent.wheel(pic1, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 150 });
      expect(notPrevented).toBe(false);
      expect(useCompareUi.getState().viewport).toBe(vp0);
      expect(pic1.style.transform).toBe(before1);
      raf.flush();
      expect(pic1.style.transform).not.toBe(before1);
      // 同步开：别的格子一起变
      expect(pic2.style.transform).not.toBe(before2);
      expect(useCompareUi.getState().viewport).toBe(vp0);
      act(() => vi.advanceTimersByTime(150));
      const vp = useCompareUi.getState().viewport;
      expect(vp.scale.kind === "rel" && vp.scale.k > 1).toBe(true);
    } finally {
      vi.useRealTimers();
      raf.restore();
      restore();
    }
  });

  it("同步关时 Ctrl+滚轮只改鼠标所在的格", () => {
    const restore = fakeBox();
    const raf = fakeRaf();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, compareSyncOnEnter: false } });
      useThumbs.getState().markReady([{ id: 1, v: "1-101" }, { id: 2, v: "1-102" }], 640);
      const { container } = render(<CompareView />);
      const pic1 = cell(container, 1).querySelector<HTMLImageElement>(".compare-pic")!;
      const pic2 = cell(container, 2).querySelector<HTMLImageElement>(".compare-pic")!;
      const before2 = pic2.style.transform;
      fireEvent.wheel(pic1, { deltaY: -100, metaKey: true, clientX: 100, clientY: 150 });
      raf.flush();
      expect(pic2.style.transform).toBe(before2);
      act(() => vi.advanceTimersByTime(150));
      const s = useCompareUi.getState();
      expect(s.viewport).toEqual(FIT_VIEWPORT);
      expect(s.perCell!.get(1)!.scale).not.toEqual(FIT_VIEWPORT.scale);
      expect(s.perCell!.has(2)).toBe(false);
    } finally {
      vi.useRealTimers();
      raf.restore();
      restore();
    }
  });

  it("无修饰键的滚轮不拦默认行为（让图片墙滚动），视口不变", () => {
    const { container } = render(<CompareView />);
    const vp0 = useCompareUi.getState().viewport;
    expect(fireEvent.wheel(cell(container, 1).querySelector(".compare-img")!, { deltaY: 100 })).toBe(true);
    expect(useCompareUi.getState().viewport).toBe(vp0);
  });

  describe("拖动平移", () => {
    let restoreBox = () => {};
    let raf: ReturnType<typeof fakeRaf>;
    beforeEach(() => {
      restoreBox = fakeBox();
      raf = fakeRaf();
      useThumbs.getState().markReady([{ id: 1, v: "1-101" }, { id: 2, v: "1-102" }], 640);
    });
    afterEach(() => {
      raf.restore();
      restoreBox();
    });

    const down = (el: Element, x: number, y: number) =>
      fireEvent.pointerDown(el, { button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y });
    const move = (el: Element, x: number, y: number) =>
      fireEvent.pointerMove(el, { button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y });
    const up = (el: Element, x: number, y: number) =>
      fireEvent.pointerUp(el, { button: 0, buttons: 0, pointerId: 1, clientX: x, clientY: y });

    it("放大的格里拖动：rAF 后 transform 改变，抬起时写回 compareUi", () => {
      const { container } = render(<CompareView />);
      const zoomed = { scale: { kind: "rel" as const, k: 2 }, u: 0.5, v: 0.5 };
      act(() => useCompareUi.setState({ viewport: zoomed }));
      raf.flush();
      const pic1 = cell(container, 1).querySelector<HTMLImageElement>(".compare-pic")!;
      const pic2 = cell(container, 2).querySelector<HTMLImageElement>(".compare-pic")!;
      const before1 = pic1.style.transform;
      const before2 = pic2.style.transform;
      down(pic1, 100, 150);
      move(pic1, 80, 120);
      expect(useCompareUi.getState().viewport).toBe(zoomed);
      raf.flush();
      expect(pic1.style.transform).not.toBe(before1);
      expect(pic2.style.transform).not.toBe(before2);
      expect(useCompareUi.getState().viewport).toBe(zoomed);
      act(() => {
        up(pic1, 80, 120);
      });
      const vp = useCompareUi.getState().viewport;
      expect(vp.scale).toEqual(zoomed.scale);
      // 向左上拖：看到图的右下方
      expect(vp.u).toBeGreaterThan(0.5);
      expect(vp.v).toBeGreaterThan(0.5);
      // 拖动之后的 click 不算单击：焦点不变
      fireEvent.click(cell(container, 2).querySelector(".compare-img")!);
      expect(useCompareUi.getState().focus).toBe(1);
    });

    it("移动不到 4 px 再抬起算单击：设焦点、不平移", () => {
      const { container } = render(<CompareView />);
      const zoomed = { scale: { kind: "rel" as const, k: 2 }, u: 0.5, v: 0.5 };
      act(() => useCompareUi.setState({ viewport: zoomed }));
      const pic2 = cell(container, 2).querySelector<HTMLImageElement>(".compare-pic")!;
      down(pic2, 100, 150);
      move(pic2, 102, 151);
      act(() => {
        up(pic2, 102, 151);
      });
      fireEvent.click(pic2);
      raf.flush();
      expect(useCompareUi.getState().viewport).toBe(zoomed);
      expect(useCompareUi.getState().focus).toBe(2);
    });

    it("没放大的格里拖动不平移：视口与图片 transform 不变", () => {
      const { container } = render(<CompareView />);
      const pic1 = cell(container, 1).querySelector<HTMLImageElement>(".compare-pic")!;
      const before = pic1.style.transform;
      const vp0 = useCompareUi.getState().viewport;
      down(pic1, 100, 150);
      move(pic1, 40, 60);
      act(() => {
        up(pic1, 40, 60);
      });
      raf.flush();
      expect(useCompareUi.getState().viewport).toBe(vp0);
      expect(pic1.style.transform).toBe(before);
    });
  });

  describe("拖动排序", () => {
    // 4 列，格子 100×160，间隙 10，网格左上角 (16, 16)；滚动区 (0, 0)–(500, 300)（与 fakeBox 的 clientHeight 一致）
    const PITCH_X = 110;
    const PITCH_Y = 170;
    let restoreBox = () => {};
    let raf: ReturnType<typeof fakeRaf>;
    let rectDesc: PropertyDescriptor;
    beforeEach(() => {
      restoreBox = fakeBox();
      raf = fakeRaf();
      rectDesc = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
      Object.defineProperty(Element.prototype, "getBoundingClientRect", {
        configurable: true,
        value(this: Element) {
          const rect = (x: number, y: number, w: number, h: number) =>
            ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON() {} }) as DOMRect;
          if (this.classList.contains("compare-scroller")) return rect(0, 0, 500, 300);
          if (this.classList.contains("compare-cell")) {
            const scroller = this.closest<HTMLElement>(".compare-scroller")!;
            const i = [...this.parentElement!.children].indexOf(this);
            return rect(16 + (i % 4) * PITCH_X, 16 + Math.floor(i / 4) * PITCH_Y - scroller.scrollTop, 100, 160);
          }
          return rect(0, 0, 0, 0);
        },
      });
    });
    afterEach(() => {
      Object.defineProperty(Element.prototype, "getBoundingClientRect", rectDesc);
      raf.restore();
      restoreBox();
    });

    const pic = (c: HTMLElement, id: FileId) => cell(c, id).querySelector(".compare-img")!;
    const at = (i: number) => ({ x: 16 + (i % 4) * PITCH_X + 50, y: 16 + Math.floor(i / 4) * PITCH_Y + 80 });
    const down = (el: Element, p: { x: number; y: number }, mods: Record<string, boolean> = {}) =>
      fireEvent.pointerDown(el, { button: 0, buttons: 1, pointerId: 1, clientX: p.x, clientY: p.y, ...mods });
    const move = (el: Element, p: { x: number; y: number }) =>
      fireEvent.pointerMove(el, { button: 0, buttons: 1, pointerId: 1, clientX: p.x, clientY: p.y });
    const up = (el: Element, p: { x: number; y: number }) =>
      act(() => {
        fireEvent.pointerUp(el, { button: 0, buttons: 0, pointerId: 1, clientX: p.x, clientY: p.y });
      });
    const transforms = (c: HTMLElement) => [...cells(c)].map((e) => (e as HTMLElement).style.transform);
    /** transform 里的平移量（jsdom 会把 translate(x, 0px) 规整成 translate(x)）。 */
    const shift = (el: HTMLElement) => {
      const m = /^translate\((-?[\d.]+)px(?:, (-?[\d.]+)px)?\)$/.exec(el.style.transform);
      return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
    };

    it("drag reorders unzoomed cells：拖动中写 transform 预览，松开后 order 变为 [2,3,1]、焦点落在被拖的格", () => {
      const { container } = render(<CompareView />);
      const el = pic(container, 1);
      down(el, at(0));
      move(el, { x: at(0).x + 10, y: at(0).y });
      move(el, at(2));
      raf.flush();
      // 被拖的格跟着指针，其余两格各让一位；store 不变
      expect(useBasket.getState().order).toEqual([1, 2, 3]);
      expect(shift(cell(container, 1))).toEqual([2 * PITCH_X, 0]);
      expect(shift(cell(container, 2))).toEqual([-PITCH_X, 0]);
      expect(shift(cell(container, 3))).toEqual([-PITCH_X, 0]);
      expect(cell(container, 1).classList.contains("is-dragging")).toBe(true);
      up(el, at(2));
      expect(useBasket.getState().order).toEqual([2, 3, 1]);
      expect(useCompareUi.getState().focus).toBe(1);
      expect(transforms(container)).toEqual(["", "", ""]);
      expect(container.querySelector(".is-dragging, .is-sorting")).toBeNull();
      // 拖动之后的 click / dblclick 不算
      fireEvent.click(pic(container, 3));
      fireEvent.doubleClick(pic(container, 3));
      expect(useCompareUi.getState().focus).toBe(1);
      expect(topView().kind).toBe("compare");
    });

    it("拖到最后一格之后的空槽：移到末尾", () => {
      const { container } = render(<CompareView />);
      const el = pic(container, 1);
      down(el, at(0));
      move(el, at(3));
      up(el, at(3));
      expect(useBasket.getState().order).toEqual([2, 3, 1]);
    });

    it("zoomed cell drags pan, not sort", () => {
      const { container } = render(<CompareView />);
      act(() => useCompareUi.setState({ viewport: { scale: { kind: "rel", k: 2 }, u: 0.5, v: 0.5 } }));
      const el = pic(container, 1);
      down(el, at(0));
      move(el, at(2));
      raf.flush();
      expect(transforms(container)).toEqual(["", "", ""]);
      up(el, at(2));
      expect(useBasket.getState().order).toEqual([1, 2, 3]);
      expect(useCompareUi.getState().viewport.u).not.toBe(0.5);
    });

    it("escape cancels drag：格子回原位，Esc 不再传给命令表", () => {
      const { container } = render(<CompareView />);
      const later = vi.fn();
      window.addEventListener("keydown", later);
      try {
        const el = pic(container, 1);
        down(el, at(0));
        move(el, at(2));
        raf.flush();
        const notPrevented = fireEvent.keyDown(window, { key: "Escape" });
        expect(notPrevented).toBe(false);
        expect(later).not.toHaveBeenCalled();
        expect(transforms(container)).toEqual(["", "", ""]);
        expect(container.querySelector(".is-dragging, .is-sorting")).toBeNull();
        up(el, at(2));
        expect(useBasket.getState().order).toEqual([1, 2, 3]);
        // 拖动结束后 Esc 照常往下传
        fireEvent.keyDown(window, { key: "Escape" });
        expect(later).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("keydown", later);
      }
    });

    it("拖动中另一个指针按下：取消拖动，临时样式清空，Esc 恢复往下传", () => {
      const { container } = render(<CompareView />);
      const later = vi.fn();
      window.addEventListener("keydown", later);
      try {
        const el = pic(container, 1);
        down(el, at(0));
        move(el, at(2));
        raf.flush();
        fireEvent.pointerDown(pic(container, 3), { button: 0, buttons: 1, pointerId: 2, clientX: at(2).x, clientY: at(2).y });
        expect(transforms(container)).toEqual(["", "", ""]);
        expect(container.querySelector(".is-dragging, .is-sorting")).toBeNull();
        fireEvent.keyDown(window, { key: "Escape" });
        expect(later).toHaveBeenCalledTimes(1);
        up(el, at(2));
        expect(useBasket.getState().order).toEqual([1, 2, 3]);
      } finally {
        window.removeEventListener("keydown", later);
      }
    });

    it("modifier press does not start drag", () => {
      for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
        const { container, unmount } = render(<CompareView />);
        const el = pic(container, 1);
        down(el, at(0), { [mod]: true });
        move(el, at(2));
        raf.flush();
        expect(transforms(container)).toEqual(["", "", ""]);
        up(el, at(2));
        expect(useBasket.getState().order).toEqual([1, 2, 3]);
        unmount();
      }
    });

    it("边缘自动滚动：滚动后按新位置重算目标", () => {
      useBasket.setState({
        order: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        items: new Map([...ITEMS, ...[4, 5, 6, 7, 8, 9].map((id) => item(id, `${id}.png`, 1024, 1536))].map((i) => [i.id, i])),
        missing: new Set(),
      });
      vi.mocked(api.basketCheck).mockReturnValue(new Promise(() => {}));
      const { container } = render(<CompareView />);
      const scroller = container.querySelector<HTMLElement>(".compare-scroller")!;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
      const el = pic(container, 1);
      down(el, at(0));
      // 指针贴近底边（第 2 行第 1 格的位置）：自动向下滚
      const edge = { x: at(0).x, y: 298 };
      move(el, edge);
      raf.flush();
      expect(scroller.scrollTop).toBeGreaterThan(0);
      // 第一帧目标是第 2 行第 1 格（下标 4）：原在下标 4 的那格让到下标 3
      expect(shift(cell(container, 5))).toEqual([3 * PITCH_X, -PITCH_Y]);
      for (let i = 0; i < 20; i++) raf.flush();
      // 滚过约一行半后指针落在第 3 行之后的空槽 → 末尾；松开不需要再动鼠标
      expect(scroller.scrollTop).toBeGreaterThan(PITCH_Y + 60);
      up(el, edge);
      expect(useBasket.getState().order).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 1]);
    });
  });
});
