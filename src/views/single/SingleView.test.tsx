// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { allCommands, findCommand } from "../../app/commands";
import { appVersion, basketRestore, imageDetails, openPath, onOpenRequest, takeOpenRequest, thumbsSubscribe, thumbsWant, updateCheck } from "../../ipc/api";
import { selectOnly } from "../../lib/selection";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useSingleUi } from "../../stores/singleUi";
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

// 单张视图显示预加载器解码好的元素：jsdom 没有 decode()，打桩为立即成功
const decoded = () => act(async () => {});

beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(takeOpenRequest).mockResolvedValue(null);
  vi.mocked(basketRestore).mockResolvedValue([]);
  vi.mocked(updateCheck).mockResolvedValue(null);
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(onOpenRequest).mockResolvedValue(() => {});
  vi.mocked(thumbsWant).mockResolvedValue([]);
  stubSize("clientWidth", 600);
  stubSize("clientHeight", 400);
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  restore.push(() =>
    desc ? Object.defineProperty(HTMLImageElement.prototype, "decode", desc) : delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode,
  );
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
});
afterEach(() => {
  vi.useRealTimers();
  for (const r of restore) r();
  restore = [];
  useSingleUi.setState({ infoOpen: false });
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
  it("双击格子进入单张视图，Esc 返回，网格仍在文档里", async () => {
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
    await decoded();
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

  it("回车打开焦点所在的图；没有焦点时不进入", async () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3);
    key("Enter");
    expect(topView().kind).toBe("grid");
    expect(singleImg(container)).toBeNull();

    act(() => useSelection.getState().set(selectOnly(3)));
    key("Enter");
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    await decoded();
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
  });

  it("正在看的图被移除后显示下一张；全部移除后回到网格", async () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3, 4);
    act(() => useNav.getState().openSingle(2));
    remove(1, 2);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    await decoded();
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
    remove(1, 3, 4);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 1 });
    remove(1, 1);
    expect(topView()).toEqual({ kind: "grid" });
    expect(singleImg(container)).toBeNull();
    expect(gridView(container)).toBeTruthy();
  });

  it("直接打开图片文件时自动进入单张视图，且只进入一次", async () => {
    open(3);
    const { container } = render(<App />);
    add(1, 1, 2);
    expect(topView().kind).toBe("grid");
    add(1, 3);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    await decoded();
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/3?v=1-1");
    key("Escape");
    expect(topView().kind).toBe("grid");
    add(1, 4);
    act(() => useCatalog.getState().apply({ type: "done", generation: 1, total: 4 }));
    expect(topView().kind).toBe("grid");
  });

  it("网格工具栏的下拉框有焦点时打开单张视图：网格设为 inert、焦点移走，Esc 仍能返回", async () => {
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

  it("按住 Esc：返回网格后，自动重复的 Esc 不清空选中；单张视图里重复的 Esc 也不返回", async () => {
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

  it("当前图内容变化（size 或 mtime 变了）后图片地址随之变化", async () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2);
    act(() => useNav.getState().openSingle(2));
    await decoded();
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/2?v=1-1");
    add(1, { id: 2, size: 5, mtimeMs: 9 });
    await decoded();
    expect(singleImg(container)!.getAttribute("src")).toBe("glance://localhost/image/2?v=9-5");
  });
});

describe("单张视图的命令", () => {
  it("单张视图的命令在应用启动时就已注册：从网格打开的快捷键一览里也有", () => {
    open(null);
    render(<App />);
    add(1, 1, 2);
    expect(topView().kind).toBe("grid");
    const prev = allCommands().find((c) => c.id === "single.prev");
    // 编辑中也登记（批量模式里左右键在选中的图之间切），普通编辑由 when 挡住
    expect(prev?.views).toEqual(["single", "edit"]);
    // 网格里方向键仍归网格
    expect(findCommand({ key: "ArrowRight", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent, "grid", false, true)?.id).toBe("nav.right");
    // 没有单张视图时直接调用也不出错、不做事
    allCommands().find((c) => c.id === "single.toggleInfo")!.run({ shift: false, repeat: false });
    allCommands().find((c) => c.id === "single.back")!.run({ shift: false, repeat: false });
    allCommands().find((c) => c.id === "single.zoomIn")!.run({ shift: false, repeat: false });
    expect(useSingleUi.getState().infoOpen).toBe(false);
    expect(topView().kind).toBe("grid");
  });

  it("单张视图里 F5 / Mod+R 刷新目录并拦下默认行为，视图栈保留", async () => {
    vi.mocked(openPath).mockResolvedValue({ generation: 2, path: "/p", name: "p", recursive: true, focus: null });
    open(null);
    render(<App />);
    add(1, 1, 2);
    act(() => useNav.getState().openSingle(2));
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(document.body, { key: "F5" });
    });
    expect(notPrevented).toBe(false);
    await act(async () => {});   // 打开先排队，openPath 在下一个微任务才发起
    expect(openPath).toHaveBeenCalledWith("/p", true, expect.any(Number), false, expect.any(Function));
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    act(() => {
      notPrevented = fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    });
    expect(notPrevented).toBe(false);
    await act(async () => {});
    expect(openPath).toHaveBeenCalledTimes(2);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
  });

  it("当前图被改名：保留同一个图片元素（不重新解码），顶栏显示新名字", async () => {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3);
    act(() => useNav.getState().openSingle(2));
    await decoded();
    const before = singleImg(container)!;
    act(() => useCatalog.getState().apply({ type: "renamed", generation: 1, items: [{ id: 2, relPath: "z.jpg" }] }));
    await decoded();
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    expect(singleImg(container)).toBe(before);
    expect(container.querySelector(".single-topbar .topbar-name")!.textContent).toBe("z.jpg");
  });
});

describe("工具栏淡出", () => {
  // jsdom 里聚焦的元素总是匹配 :focus-visible：打桩，由用例决定焦点是键盘的还是鼠标的
  let focusVisible = true;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(imageDetails).mockResolvedValue({
      path: "/p/2.jpg",
      mtimeMs: 1,
      color: null,
      bitDepth: null,
      hasAlpha: null,
      dpi: null,
      animated: false,
      exif: [],
    });
    focusVisible = true;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "matches")!;
    const orig = Element.prototype.matches;
    Object.defineProperty(Element.prototype, "matches", {
      configurable: true,
      writable: true,
      value(this: Element, sel: string) {
        return sel === ":focus-visible" ? focusVisible && document.activeElement === this : orig.call(this, sel);
      },
    });
    restore.push(() => Object.defineProperty(Element.prototype, "matches", desc));
  });

  function enter() {
    open(null);
    const { container } = render(<App />);
    add(1, 1, 2, 3);
    act(() => useNav.getState().openSingle(2));
    return container;
  }
  const idle = (c: HTMLElement) => c.querySelector(".single-view")!.classList.contains("idle");
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("鼠标静止 2 秒后淡出", () => {
    const c = enter();
    wait(1999);
    expect(idle(c)).toBe(false);
    wait(1);
    expect(idle(c)).toBe(true);
  });

  it("指针在顶栏或缩略图条上时不淡出", () => {
    const c = enter();
    fireEvent.pointerOver(c.querySelector(".single-topbar")!);
    wait(5000);
    expect(idle(c)).toBe(false);
    fireEvent.pointerOver(c.querySelector(".stage")!);
    wait(2000);
    expect(idle(c)).toBe(true);
    fireEvent.pointerOver(c.querySelector(".single-strip")!);
    expect(idle(c)).toBe(false);
    wait(5000);
    expect(idle(c)).toBe(false);
  });

  it("详细信息面板展开时不淡出", () => {
    const c = enter();
    act(() => useSingleUi.setState({ infoOpen: true }));
    wait(5000);
    expect(idle(c)).toBe(false);
    act(() => useSingleUi.setState({ infoOpen: false }));
    wait(2000);
    expect(idle(c)).toBe(true);
  });

  it("键盘焦点在顶栏按钮上时不淡出；鼠标点出的焦点不算", () => {
    const c = enter();
    const btn = c.querySelector<HTMLButtonElement>(".single-topbar .topbar-info")!;
    focusVisible = false;
    act(() => btn.focus());
    wait(2000);
    expect(idle(c)).toBe(true);
    act(() => btn.blur());
    focusVisible = true;
    act(() => btn.focus());
    expect(idle(c)).toBe(false);
    wait(5000);
    expect(idle(c)).toBe(false);
    act(() => btn.blur());
    wait(2000);
    expect(idle(c)).toBe(true);
  });
});
