// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleKeyDown } from "../../app/useKeyboard";
import { t } from "../../i18n";
import { fsCopy, fsMove, thumbsWant } from "../../ipc/api";
import type { OpReport } from "../../ipc/types";
import { useCatalog } from "../../stores/catalog";
import { useDrag } from "../../stores/drag";
import { useGridCtx } from "../../stores/gridCtx";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { startRename, stopRename } from "../../stores/rename";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import { useToast } from "../../stores/toast";
import GridView from "./GridView";

vi.mock("../../ipc/api");
const env = vi.hoisted(() => ({ mac: true }));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  get IS_MAC() { return env.mac; },
}));

const ids = () => [...useSelection.getState().ids].sort((a, b) => a - b);

describe("GridView 缩略图拖拽", () => {
  let restore: (() => void)[] = [];
  let setCapture: ReturnType<typeof vi.fn>;
  let frames = new Map<number, FrameRequestCallback>();
  let frameSeq = 0;
  let hit: Element | null = null;
  /** 推进一帧：只跑此刻排着的回调 */
  const flush = () => act(() => {
    const run = [...frames.values()];
    frames.clear();
    for (const f of run) f(0);
  });
  const stubSize = (prop: "clientWidth" | "clientHeight", value: number) => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
    Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
  };

  beforeEach(() => {
    stubSize("clientWidth", 600);
    stubSize("clientHeight", 400);
    const rect = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0 };
    const gbcr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
    restore.push(() => { Element.prototype.getBoundingClientRect = gbcr; });
    // jsdom 没有指针捕获
    const proto = Element.prototype as unknown as Record<string, unknown>;
    const had = { set: proto.setPointerCapture, rel: proto.releasePointerCapture };
    setCapture = vi.fn();
    proto.setPointerCapture = setCapture;
    proto.releasePointerCapture = vi.fn();
    restore.push(() => { proto.setPointerCapture = had.set; proto.releasePointerCapture = had.rel; });
    // requestAnimationFrame 排进队列，由 flush() 手动推进
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.set(++frameSeq, f); return frameSeq; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => { frames.delete(n); });
    // jsdom 没有 elementFromPoint：返回 hit
    hit = null;
    const doc = document as unknown as Record<string, unknown>;
    const hadEfp = doc.elementFromPoint;
    doc.elementFromPoint = () => hit;
    restore.push(() => { doc.elementFromPoint = hadEfp; });
    env.mac = true;
    vi.mocked(fsMove).mockReset();
    vi.mocked(fsCopy).mockReset();
    vi.mocked(thumbsWant).mockResolvedValue([]); // 异步的用例会等到登记缩略图的定时器
    useToast.setState({ current: null });

    useThumbs.getState().reset();
    useSelection.getState().clear();
    useCatalog.getState().reset();
    useNav.getState().reset();
    useDrag.setState({ count: 0, copy: false, target: null });
    useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, cell: 160 });
    stopRename();
  });
  afterEach(() => {
    for (const r of restore) r();
    restore = [];
    vi.unstubAllGlobals();
  });

  const setup = (rel: (id: number) => string = (id) => `${id}.jpg`) => {
    act(() => {
      useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null }, { restored: false });
    });
    const view = render(<GridView />);
    act(() => {
      useCatalog.getState().apply({
        type: "batch",
        generation: 1,
        entries: [1, 2, 3, 4].map((id) => ({ id, relPath: rel(id), size: 1, mtimeMs: 1 })),
      });
    });
    const { container } = view;
    const scroller = container.querySelector(".grid-scroll") as HTMLElement;
    const cell = (id: number) => container.querySelector(`[data-id="${id}"]`) as HTMLElement;
    return { ...view, scroller, cell };
  };
  const badge = () => document.querySelector(".drag-badge") as HTMLElement | null;
  const select3 = () => act(() => useSelection.getState().set({ ids: new Set([1, 2, 3]), focus: 1, anchor: 1 }));
  /** 在格子上按下（坐标 50,100），再移动到 (x, y)。 */
  const press = (el: HTMLElement, init: Record<string, unknown> = {}) =>
    fireEvent.pointerDown(el, { button: 0, buttons: 1, clientX: 50, clientY: 100, ...init });
  const move = (el: HTMLElement, x: number, y: number, buttons = 1) =>
    fireEvent.pointerMove(el, { buttons, clientX: x, clientY: y });

  it("在未选中的图上按下：立刻只选它", () => {
    const { cell } = setup();
    select3();
    press(cell(4));
    expect(ids()).toEqual([4]);
    expect(useSelection.getState().focus).toBe(4);
  });

  it("在已选多张之一上按下：选中不变，焦点移到它", () => {
    const { cell } = setup();
    select3();
    press(cell(2));
    expect(ids()).toEqual([1, 2, 3]);
    expect(useSelection.getState().focus).toBe(2);
  });

  it("在已选多张之一上按下再松开（没拖）：收成只选它", () => {
    const { cell } = setup();
    select3();
    press(cell(2));
    fireEvent.pointerUp(cell(2), { clientX: 50, clientY: 100 });
    expect(ids()).toEqual([2]);
    expect(useSelection.getState().focus).toBe(2);
  });

  it("按着 Mod 或 Shift 按下后移动 20 px：不出现徽标", () => {
    const { cell, scroller } = setup();
    press(cell(1), { metaKey: true });
    move(scroller, 70, 100);
    expect(badge()).toBeNull();
    fireEvent.pointerUp(scroller);
    press(cell(2), { shiftKey: true });
    move(scroller, 70, 100);
    expect(badge()).toBeNull();
    expect(setCapture).not.toHaveBeenCalled();
  });

  it("移动不超过 4 px：不出现徽标；激活前没有调用 setPointerCapture", () => {
    const { cell, scroller } = setup();
    press(cell(1));
    move(scroller, 53, 102);
    expect(badge()).toBeNull();
    expect(setCapture).not.toHaveBeenCalled();
    expect(scroller.classList.contains("grid-dragging")).toBe(false);
  });

  it("拖动已选 3 张之一超过 4 px：徽标出现，文字含 3，选中仍是 3 张", () => {
    const { cell, scroller } = setup();
    select3();
    press(cell(2));
    move(scroller, 60, 100);
    expect(badge()).not.toBeNull();
    expect(badge()!.textContent).toContain("3");
    expect(ids()).toEqual([1, 2, 3]);
    expect(useDrag.getState().count).toBe(3);
    expect(setCapture).toHaveBeenCalledTimes(1);
    expect(scroller.classList.contains("grid-dragging")).toBe(true);
  });

  it("拖动未选中的图：徽标文字含 1", () => {
    const { cell, scroller } = setup();
    select3();
    press(cell(4));
    move(scroller, 60, 100);
    expect(badge()!.textContent).toContain("1");
    expect(ids()).toEqual([4]);
  });

  it("激活后移动：徽标的 transform 跟着指针加 (12, 12)", () => {
    const { cell, scroller } = setup();
    press(cell(1));
    move(scroller, 60, 100);
    move(scroller, 200, 150);
    expect(badge()!.style.transform).toBe("translate(212px, 162px)");
    move(scroller, 300, 20);
    expect(badge()!.style.transform).toBe("translate(312px, 32px)");
  });

  it("松手：徽标消失，grid-dragging 类名去掉，选中不变", () => {
    const { cell, scroller } = setup();
    select3();
    press(cell(2));
    move(scroller, 60, 100);
    fireEvent.pointerUp(scroller, { clientX: 60, clientY: 100 });
    expect(badge()).toBeNull();
    expect(scroller.classList.contains("grid-dragging")).toBe(false);
    expect(ids()).toEqual([1, 2, 3]);
    expect(useDrag.getState()).toMatchObject({ count: 0, copy: false, target: null });
    // 已经结束：之后的移动不再出现徽标
    move(scroller, 200, 100);
    expect(badge()).toBeNull();
  });

  it("拖动中按 Esc：徽标消失，选中不变，没有触发清空选中", () => {
    const { cell, scroller } = setup();
    window.addEventListener("keydown", handleKeyDown);
    restore.push(() => window.removeEventListener("keydown", handleKeyDown));
    select3();
    press(cell(2));
    move(scroller, 60, 100);
    fireEvent.keyDown(scroller, { key: "Escape" });
    expect(badge()).toBeNull();
    expect(ids()).toEqual([1, 2, 3]);
    // 松手不再收成单选；之后的 Esc 照常清空
    fireEvent.pointerUp(scroller);
    expect(ids()).toEqual([1, 2, 3]);
    fireEvent.keyDown(scroller, { key: "Escape" });
    expect(ids()).toEqual([]);
  });

  it("拖动中收到 pointercancel / lostpointercapture / buttons 为 0 的移动：徽标消失", () => {
    const { cell, scroller } = setup();
    select3();
    press(cell(2));
    move(scroller, 60, 100);
    fireEvent.pointerCancel(scroller);
    expect(badge()).toBeNull();
    expect(scroller.classList.contains("grid-dragging")).toBe(false);

    press(cell(2));
    move(scroller, 60, 100);
    expect(badge()).not.toBeNull();
    fireEvent.lostPointerCapture(scroller);
    expect(badge()).toBeNull();

    press(cell(2));
    move(scroller, 60, 100);
    expect(badge()).not.toBeNull();
    move(scroller, 80, 100, 0);
    expect(badge()).toBeNull();
    expect(ids()).toEqual([1, 2, 3]);
  });

  it("拖动中网格被单张视图盖住（enabled 变假）：徽标消失", () => {
    const { cell, scroller, rerender } = setup();
    press(cell(1));
    move(scroller, 60, 100);
    expect(badge()).not.toBeNull();
    rerender(<GridView hidden />);
    expect(badge()).toBeNull();
    expect(scroller.classList.contains("grid-dragging")).toBe(false);
    expect(useDrag.getState().count).toBe(0);
  });

  it("卸载：回到空闲", () => {
    const { cell, scroller, unmount } = setup();
    press(cell(1));
    move(scroller, 60, 100);
    unmount();
    expect(useDrag.getState().count).toBe(0);
  });

  it("重命名输入框里按下并移动：不开始拖拽", () => {
    const { container, scroller } = setup();
    act(() => startRename(1));
    const input = container.querySelector(".rename-input") as HTMLElement;
    expect(input).not.toBeNull();
    press(input);
    move(scroller, 80, 100);
    expect(badge()).toBeNull();
    expect(useDrag.getState().count).toBe(0);
  });

  it("双击（没拖）照常进入单张视图", () => {
    const { cell } = setup();
    press(cell(3));
    fireEvent.pointerUp(cell(3));
    fireEvent.doubleClick(cell(3));
    expect(topView()).toMatchObject({ kind: "single", id: 3 });
  });

  it("徽标是第一张时 moveBadge 的位置在挂载时补上", async () => {
    const { moveBadge } = await import("./DragBadge");
    const { cell, scroller } = setup();
    expect(() => moveBadge(1, 1)).not.toThrow(); // 未挂载时什么都不做
    press(cell(1));
    move(scroller, 60, 100);
    expect(badge()!.style.transform).toBe("translate(72px, 112px)");
  });
  it("Windows 上按着 Win 键在已选多张之一上按下：立刻收成只选它，不开始拖拽", () => {
    env.mac = false;
    const { cell, scroller } = setup();
    select3();
    press(cell(2), { metaKey: true });
    expect(ids()).toEqual([2]);
    move(scroller, 70, 100);
    expect(badge()).toBeNull();
    fireEvent.pointerUp(scroller);
    expect(ids()).toEqual([2]);
  });

  it("拖动中另一个指针按下：不打断这次拖拽，也不改选中", () => {
    const { cell, scroller } = setup();
    select3();
    press(cell(2), { pointerId: 1 });
    fireEvent.pointerMove(scroller, { pointerId: 1, buttons: 1, clientX: 60, clientY: 100 });
    expect(useDrag.getState().count).toBe(3);
    press(cell(4), { pointerId: 2 });
    expect(useDrag.getState().count).toBe(3);
    expect(ids()).toEqual([1, 2, 3]);
    fireEvent.pointerMove(scroller, { pointerId: 1, buttons: 1, clientX: 100, clientY: 100 });
    expect(badge()!.style.transform).toBe("translate(112px, 112px)");
    fireEvent.pointerUp(scroller, { pointerId: 1 });
    expect(useDrag.getState().count).toBe(0);
    expect(ids()).toEqual([1, 2, 3]);
  });

  describe("拖到目录树", () => {
    // 1、2 在 a，3 在根目录，4 在 b
    const rels: Record<number, string> = { 1: "a/1.jpg", 2: "a/2.jpg", 3: "3.jpg", 4: "b/4.jpg" };
    const setupTree = () => {
      const v = setup((id) => rels[id]);
      const row = (dir: string) => v.container.querySelector(`[data-drop-dir="${dir}"]`) as HTMLElement;
      return { ...v, row };
    };
    const report = (r: Partial<OpReport>): OpReport => ({ kind: "move", done: [], failed: [], token: null, dest: "/p/x", ...r });
    const listOrder = (want: number[]) => useGridCtx.getState().list.ids.filter((id) => want.includes(id));
    const highlighted = () => [...document.querySelectorAll(".dir-item-drop")];
    /** 选中 sel，在 pressed 上按下拖起来，再移到 row 上（推进一帧） */
    const dragTo = (cell: (id: number) => HTMLElement, scroller: HTMLElement, pressed: number, target: HTMLElement | null, init: Record<string, unknown> = {}) => {
      press(cell(pressed));
      move(scroller, 60, 100);
      hit = target;
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 30, clientY: 200, ...init });
      flush();
    };
    const selectIds = (...xs: number[]) => act(() => useSelection.getState().set({ ids: new Set(xs), focus: xs[0], anchor: xs[0] }));

    it("“全部图片”与各目录行带 data-drop-dir", () => {
      const { row } = setupTree();
      expect(row("")).not.toBeNull();
      expect(row("a")).not.toBeNull();
      expect(row("b")).not.toBeNull();
    });

    it("拖到另一个目录的行上：该行带 dir-item-drop，离开后去掉", () => {
      const { cell, scroller, row } = setupTree();
      dragTo(cell, scroller, 1, row("b").querySelector(".dir-name"));
      expect(row("b").classList.contains("dir-item-drop")).toBe(true);
      expect(highlighted()).toHaveLength(1);
      expect(useDrag.getState().target).toBe("b");
      hit = scroller;
      move(scroller, 300, 200);
      flush();
      expect(highlighted()).toHaveLength(0);
      expect(useDrag.getState().target).toBeNull();
    });

    it("拖到文件所在目录的行上：不高亮；松手不调用 fsMove", () => {
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2);
      dragTo(cell, scroller, 1, row("a"));
      expect(highlighted()).toHaveLength(0);
      expect(useDrag.getState().target).toBeNull();
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).not.toHaveBeenCalled();
      expect(fsCopy).not.toHaveBeenCalled();
      expect(useToast.getState().current).toBeNull();
    });

    it("松手在有效目录上：fsMove(ids, { kind: 'dir', dir }, 'skip')，ids 是选中且不在该目录里的，按列表顺序", async () => {
      vi.mocked(fsMove).mockResolvedValue(report({}));
      const { cell, scroller, row } = setupTree();
      selectIds(3, 2, 1);
      dragTo(cell, scroller, 2, row("a"));
      expect(useDrag.getState().target).toBe("a");
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).toHaveBeenCalledTimes(1);
      expect(fsMove).toHaveBeenCalledWith([3], { kind: "dir", dir: "a" }, "skip");
      await act(async () => {}); // 等上一次操作应答，否则下一次被“进行中”挡下

      dragTo(cell, scroller, 2, row("b"));
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).toHaveBeenLastCalledWith(listOrder([1, 2, 3]), { kind: "dir", dir: "b" }, "skip");
      expect(useDrag.getState().count).toBe(0);
    });

    it("松手在“全部图片”行上：目标是 { kind: 'dir', dir: '' }", () => {
      vi.mocked(fsMove).mockResolvedValue(report({}));
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2);
      dragTo(cell, scroller, 1, row(""));
      expect(row("").classList.contains("dir-item-drop")).toBe(true);
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).toHaveBeenCalledWith(listOrder([1, 2]), { kind: "dir", dir: "" }, "skip");
    });

    it("松手时以最后的指针位置为准（还没推进的那一帧也算上）", () => {
      vi.mocked(fsMove).mockResolvedValue(report({}));
      const { cell, scroller, row } = setupTree();
      dragTo(cell, scroller, 1, null);
      hit = row("b");
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 220 });
      expect(fsMove).toHaveBeenCalledWith([1], { kind: "dir", dir: "b" }, "skip");
    });

    it("按着复制修饰键松手：调用 fsCopy，徽标文字是复制的那句；含已在该目录里的文件", () => {
      vi.mocked(fsCopy).mockResolvedValue(report({ kind: "copy" }));
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2, 3);
      dragTo(cell, scroller, 1, row("a"), { altKey: true });
      expect(badge()!.textContent).toBe(t("drag.countCopy", { n: 3 }));
      expect(row("a").classList.contains("dir-item-drop")).toBe(true);
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200, altKey: true });
      expect(fsMove).not.toHaveBeenCalled();
      expect(fsCopy).toHaveBeenCalledWith(listOrder([1, 2, 3]), { kind: "dir", dir: "a" }, "skip");
    });

    it("拖动中按下再松开复制修饰键（不动鼠标）：徽标文字跟着变", () => {
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2);
      dragTo(cell, scroller, 1, row("a"));
      expect(badge()!.textContent).toBe(t("drag.count", { n: 2 }));
      expect(highlighted()).toHaveLength(0);
      fireEvent.keyDown(window, { key: "Alt", altKey: true });
      flush();
      expect(badge()!.textContent).toBe(t("drag.countCopy", { n: 2 }));
      expect(row("a").classList.contains("dir-item-drop")).toBe(true); // 复制到所在目录照常可以
      fireEvent.keyUp(window, { key: "Alt", altKey: false });
      flush();
      expect(badge()!.textContent).toBe(t("drag.count", { n: 2 }));
      expect(highlighted()).toHaveLength(0);
    });

    it("松手在目录树之外：不调用后端", () => {
      const { cell, scroller } = setupTree();
      dragTo(cell, scroller, 1, scroller);
      fireEvent.pointerUp(scroller, { clientX: 300, clientY: 200 });
      expect(fsMove).not.toHaveBeenCalled();
      expect(fsCopy).not.toHaveBeenCalled();
    });

    it("拖动途中条目被移除：松手时不再包含它；全都没了就不调用", async () => {
      vi.mocked(fsMove).mockResolvedValue(report({}));
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2, 3);
      dragTo(cell, scroller, 1, row("b"));
      act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: [2] }));
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).toHaveBeenCalledWith(listOrder([1, 3]), { kind: "dir", dir: "b" }, "skip");

      await act(async () => {});
      vi.mocked(fsMove).mockClear();
      selectIds(1);
      dragTo(cell, scroller, 1, row("b"));
      expect(useDrag.getState().target).toBe("b");
      act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] }));
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(fsMove).not.toHaveBeenCalled();
      expect(useDrag.getState().count).toBe(0);
    });

    it("操作成功后出现带“撤销”的提示条", async () => {
      vi.mocked(fsMove).mockResolvedValue(report({ done: [1, 2], token: 7 }));
      const { cell, scroller, row } = setupTree();
      selectIds(1, 2);
      dragTo(cell, scroller, 1, row("b"));
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      await vi.waitFor(() => {
        expect(useToast.getState().current?.actions?.some((a) => a.label === t("fs.undo"))).toBe(true);
      });
    });

    it("指针贴近目录树下边缘：列表的 scrollTop 增加", () => {
      const { container, cell, scroller } = setupTree();
      const list = container.querySelector(".dir-tree-list") as HTMLElement;
      let top = 0;
      Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(list, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (v: number) => { top = Math.min(600, Math.max(0, Math.floor(v))); },
      });
      press(cell(1));
      move(scroller, 60, 100);
      hit = list;
      move(scroller, 30, 396); // 离下边缘 4 px（各元素的矩形都打桩成 0..600 × 0..400）
      flush();
      expect(top).toBeGreaterThan(0);
      const first = top;
      flush(); // 不动鼠标也继续滚
      expect(top).toBeGreaterThan(first);
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 396 });
      const stopped = top;
      flush();
      expect(top).toBe(stopped);
      expect(frames.size).toBe(0);
    });

    it("拖拽结束（松手 / Esc）后没有任何行带 dir-item-drop", async () => {
      vi.mocked(fsMove).mockResolvedValue(report({}));
      const { cell, scroller, row } = setupTree();
      dragTo(cell, scroller, 1, row("b"));
      expect(highlighted()).toHaveLength(1);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(highlighted()).toHaveLength(0);
      expect(fsMove).not.toHaveBeenCalled();

      dragTo(cell, scroller, 1, row("b"));
      expect(highlighted()).toHaveLength(1);
      fireEvent.pointerUp(scroller, { clientX: 30, clientY: 200 });
      expect(highlighted()).toHaveLength(0);
      await act(async () => {});
    });
  });
});
