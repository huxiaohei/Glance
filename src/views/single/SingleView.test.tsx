// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { thumbsSubscribe } from "../../ipc/api";
import { selectOnly } from "../../lib/selection";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

// jsdom 不做布局：给滚动区一个尺寸，让网格布局与“打开单张后定位”能进行
let restore: (() => void)[] = [];
const stubSize = (prop: "clientWidth" | "clientHeight", value: number) => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
  Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => value });
  restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
};

beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  stubSize("clientWidth", 600);
  stubSize("clientHeight", 400);
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
});
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const open = (focus: number | null, generation = 1) => {
  act(() => {
    useCatalog.getState().begin({ generation, path: "/p", name: "p", recursive: true, focus });
  });
};
const add = (generation: number, ...items: (number | { id: number; size: number; mtimeMs: number })[]) => {
  act(() => {
    useCatalog.getState().apply({
      type: "batch",
      generation,
      entries: items.map((it) => {
        const e = typeof it === "number" ? { id: it, size: 1, mtimeMs: 1 } : it;
        return { ...e, relPath: `${e.id}.jpg` };
      }),
    });
  });
};
const remove = (generation: number, ...ids: number[]) => {
  act(() => useCatalog.getState().apply({ type: "removed", generation, ids }));
};
const key = (k: string, o: Partial<KeyboardEventInit> = {}) => {
  act(() => {
    fireEvent.keyDown(document.body, { key: k, ...o });
  });
};
const singleImg = (c: HTMLElement) => c.querySelector(".single-view img") as HTMLImageElement | null;
const gridView = (c: HTMLElement) => c.querySelector(".grid-view") as HTMLElement;
const cell = (c: HTMLElement, id: number) => c.querySelector(`[data-id="${id}"]`)!;

describe("单张视图", () => {
  it("双击格子进入单张视图，Esc 返回，网格仍在文档里", () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3);

    // 按着 Mod 或 Shift 双击不进入
    fireEvent.doubleClick(cell(container, 2), { button: 0, metaKey: true });
    fireEvent.doubleClick(cell(container, 2), { button: 0, shiftKey: true });
    expect(singleImg(container)).toBeNull();

    fireEvent.pointerDown(cell(container, 2), { button: 0, clientX: 10 });
    fireEvent.doubleClick(cell(container, 2), { button: 0 });
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    const img = singleImg(container)!;
    expect(img.getAttribute("src")).toBe("glance://localhost/image/2?v=1-1");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("draggable")).toBe("false");
    expect(gridView(container).classList.contains("grid-hidden")).toBe(true);

    // 网格的命令在单张视图里不生效
    key("ArrowRight");
    expect(useSelection.getState().focus).toBe(2);

    key("Escape");
    expect(topView()).toEqual({ kind: "grid" });
    expect(singleImg(container)).toBeNull();
    expect(gridView(container).classList.contains("grid-hidden")).toBe(false);
    expect([...useSelection.getState().ids]).toEqual([2]);
    expect(cell(container, 2)).toBeTruthy();
  });

  it("回车打开焦点所在的图；没有焦点时不进入", () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3);
    key("Enter");
    expect(topView().kind).toBe("grid");
    expect(singleImg(container)).toBeNull();

    act(() => useSelection.getState().set(selectOnly(3)));
    key("Enter");
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
  });

  it("正在看的图被移除后显示下一张；全部移除后回到网格", () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3, 4);
    act(() => useNav.getState().openSingle(2));
    remove(1, 2);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
    remove(1, 3, 4);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 1 });
    remove(1, 1);
    expect(topView()).toEqual({ kind: "grid" });
    expect(singleImg(container)).toBeNull();
    expect(gridView(container)).toBeTruthy();
  });

  it("直接打开图片文件时自动进入单张视图，且只进入一次", () => {
    open(3);
    const { container } = render(<App />);
    add(1, 1, 2);
    expect(topView().kind).toBe("grid");
    add(1, 3);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
    key("Escape");
    expect(topView().kind).toBe("grid");
    add(1, 4);
    act(() => useCatalog.getState().apply({ type: "done", generation: 1, total: 4 }));
    expect(topView().kind).toBe("grid");
  });

  it("网格工具栏的下拉框有焦点时打开单张视图：网格设为 inert、焦点移走，Esc 仍能返回", () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2);
    const select = container.querySelector(".grid-toolbar select") as HTMLSelectElement;
    select.focus();
    expect(document.activeElement).toBe(select);
    act(() => useNav.getState().openSingle(2));
    expect(gridView(container).hasAttribute("inert")).toBe(true);
    expect(gridView(container).contains(document.activeElement)).toBe(false);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(topView()).toEqual({ kind: "grid" });
    expect(gridView(container).hasAttribute("inert")).toBe(false);
  });

  it("按住 Esc：返回网格后，自动重复的 Esc 不清空选中；单张视图里重复的 Esc 也不返回", () => {
    open(null);
    render(<App />);
    add(1, 1, 2);
    act(() => useSelection.getState().set(selectOnly(2)));
    act(() => useNav.getState().openSingle(2));
    key("Escape", { repeat: true });
    expect(topView().kind).toBe("single");
    key("Escape");
    expect(topView().kind).toBe("grid");
    key("Escape", { repeat: true });
    expect([...useSelection.getState().ids]).toEqual([2]);
    key("Escape");
    expect(useSelection.getState().ids.size).toBe(0);
  });

  it("当前图内容变化（size 或 mtime 变了）后图片地址随之变化", () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2);
    act(() => useNav.getState().openSingle(2));
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/2?v=1-1");
    add(1, { id: 2, size: 5, mtimeMs: 9 });
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/2?v=9-5");
  });
});
