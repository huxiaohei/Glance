// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleKeyDown } from "../../app/useKeyboard";
import { useCatalog } from "../../stores/catalog";
import { useDrag } from "../../stores/drag";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { startRename, stopRename } from "../../stores/rename";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import GridView from "./GridView";

vi.mock("../../ipc/api");
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

const ids = () => [...useSelection.getState().ids].sort((a, b) => a - b);

describe("GridView 缩略图拖拽", () => {
  let restore: (() => void)[] = [];
  let setCapture: ReturnType<typeof vi.fn>;
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
    // 框选的自动滚动用到 requestAnimationFrame：这里不需要它真正跑
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});

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

  const setup = () => {
    act(() => {
      useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null }, { restored: false });
    });
    const view = render(<GridView />);
    act(() => {
      useCatalog.getState().apply({
        type: "batch",
        generation: 1,
        entries: [1, 2, 3, 4].map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
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
});
