// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { ImageEntry, ImageList } from "../../lib/deriveList";
import { handleKeyDown } from "../../app/useKeyboard";
import { GRID_PAD, layoutGrid, rowIndexOf } from "../../lib/gridLayout";
import { selectOnly } from "../../lib/selection";
import { useCatalog } from "../../stores/catalog";
import { useDrag } from "../../stores/drag";
import { useGridCtx } from "../../stores/gridCtx";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import GridView from "./GridView";
import GroupHeader from "./GroupHeader";
import ThumbCell from "./ThumbCell";

vi.mock("../../ipc/api");
// 真实虚拟器，只把 scrollToIndex 换成可观察的替身（jsdom 里滚动本身看不出来）
const scrollToIndex = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const m = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...m,
    useVirtualizer: ((opts: Parameters<typeof m.useVirtualizer>[0]) => {
      const v = m.useVirtualizer(opts);
      v.scrollToIndex = scrollToIndex;
      return v;
    }) as typeof m.useVirtualizer,
  };
});
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

const entry = (id: number, dir = ""): ImageEntry => {
  const name = `${id}.jpg`;
  return { id, relPath: dir ? `${dir}/${name}` : name, dir, name, size: 1, mtimeMs: 1 };
};
const list: ImageList = {
  ids: [1, 2, 3, 4],
  groups: [
    { dir: "", start: 0, count: 2, total: 2 },
    { dir: "sub", start: 2, count: 2, total: 2 },
  ],
};
const ids = () => [...useSelection.getState().ids].sort((a, b) => a - b);

beforeEach(() => {
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true });
  useGridCtx.setState({ list, layout: layoutGrid(list, 400, 100), reveal: vi.fn() });
});

describe("ThumbCell 指针选中", () => {
  const renderCells = () =>
    render(
      <>
        {[1, 2, 3, 4].map((id) => (
          <ThumbCell key={id} entry={entry(id)} cell={100} selected={false} focused={false} />
        ))}
      </>,
    );
  const cell = (container: HTMLElement, id: number) => container.querySelector(`[data-id="${id}"]`)!;

  it("单击选中；Mod 单击加选；Shift 单击连选", () => {
    const { container } = renderCells();
    fireEvent.pointerDown(cell(container, 1), { button: 0 });
    expect(ids()).toEqual([1]);
    expect(useSelection.getState().focus).toBe(1);

    fireEvent.pointerDown(cell(container, 3), { button: 0, metaKey: true });
    expect(ids()).toEqual([1, 3]);
    expect(useSelection.getState().anchor).toBe(3);

    fireEvent.pointerDown(cell(container, 4), { button: 0, shiftKey: true });
    expect(ids()).toEqual([3, 4]);
    expect(useSelection.getState().focus).toBe(4);
    expect(useSelection.getState().anchor).toBe(3);

    fireEvent.pointerDown(cell(container, 3), { button: 0, metaKey: true });
    expect(ids()).toEqual([4]);

    fireEvent.pointerDown(cell(container, 2), { button: 0 });
    expect(ids()).toEqual([2]);
  });

  it("右键和 macOS 上的 Ctrl 单击不改变选中", () => {
    const { container } = renderCells();
    useSelection.getState().set(selectOnly(1));
    fireEvent.pointerDown(cell(container, 2), { button: 2 });
    fireEvent.pointerDown(cell(container, 3), { button: 0, ctrlKey: true });
    expect(ids()).toEqual([1]);
  });

  it("选中和焦点各有对应的 class", () => {
    const { container, rerender } = render(<ThumbCell entry={entry(1)} cell={100} selected={false} focused={false} />);
    const el = container.querySelector(".thumb-cell")!;
    expect(el.classList.contains("thumb-selected")).toBe(false);
    expect(el.classList.contains("thumb-focused")).toBe(false);
    rerender(<ThumbCell entry={entry(1)} cell={100} selected focused={false} />);
    expect(el.classList.contains("thumb-selected")).toBe(true);
    expect(el.classList.contains("thumb-focused")).toBe(false);
    rerender(<ThumbCell entry={entry(1)} cell={100} selected focused />);
    expect(el.classList.contains("thumb-selected")).toBe(true);
    expect(el.classList.contains("thumb-focused")).toBe(true);
  });
});

describe("GroupHeader", () => {
  it("点“选中本组”选中整组且不折叠", () => {
    useSelection.getState().set(selectOnly(1));
    render(<GroupHeader dir="sub" total={2} collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: t("grid.selectGroup") }));
    expect(ids()).toEqual([3, 4]);
    expect(useListView.getState().collapsed.size).toBe(0);
  });

  it("点标题其他位置仍然折叠", () => {
    const { container } = render(<GroupHeader dir="sub" total={2} collapsed={false} />);
    fireEvent.click(container.querySelector(".group-header")!);
    expect(useListView.getState().collapsed.has("sub")).toBe(true);
  });
});

describe("GridView", () => {
  // jsdom 不做布局：给滚动区一个尺寸，让布局与“打开单张后定位”能进行
  let restore: (() => void)[] = [];
  const stubSize = (prop: "clientWidth" | "clientHeight", value: number) => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
    Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
  };

  beforeEach(() => {
    stubSize("clientWidth", 600);
    stubSize("clientHeight", 400);
    useCatalog.getState().reset();
    useNav.getState().reset();
    scrollToIndex.mockClear();
  });
  afterEach(() => {
    for (const r of restore) r();
    restore = [];
  });

  const open = (focus: number | null, generation = 1, restored = false) => {
    act(() => {
      useCatalog.getState().begin({ generation, path: "/p", name: "p", recursive: true, focus }, { restored });
    });
  };
  const add = (generation: number, ...idList: number[]) => {
    act(() => {
      useCatalog.getState().apply({
        type: "batch",
        generation,
        entries: idList.map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
      });
    });
  };

  /** scrollToIndex 是否被调用、且目标行正是 id 当前所在的行。 */
  const revealedTo = (id: number) => {
    const row = rowIndexOf(useGridCtx.getState().layout, id);
    return row >= 0 && scrollToIndex.mock.calls.some(([i, o]) => i === row && o?.align === "auto");
  };
  const done = (generation: number) => {
    act(() => useCatalog.getState().apply({ type: "done", generation, total: 0 }));
  };

  it("打开单张图片：条目到达后选中并定位，同一次打开只做一次", () => {
    open(3);
    render(<GridView />);
    add(1, 1, 2);
    expect(ids()).toEqual([]);
    expect(scrollToIndex).not.toHaveBeenCalled();
    add(1, 3);
    expect(ids()).toEqual([3]);
    expect(useSelection.getState().focus).toBe(3);
    expect(useGridCtx.getState().list.ids).toEqual([1, 2, 3]);
    expect(revealedTo(3)).toBe(true);

    act(() => useSelection.getState().set(selectOnly(1)));
    add(1, 4);
    expect(ids()).toEqual([1]);
  });

  it("扫描期间后续批次把它挤开时再次定位，扫描结束时再定位一次，之后不再跟随", () => {
    open(30);
    render(<GridView />);
    add(1, 30);
    expect(revealedTo(30)).toBe(true);
    scrollToIndex.mockClear();
    add(1, ...Array.from({ length: 20 }, (_, i) => i + 1)); // 排在 30 前面
    expect(revealedTo(30)).toBe(true);
    scrollToIndex.mockClear();
    done(1);
    expect(revealedTo(30)).toBe(true);
    scrollToIndex.mockClear();
    add(1, 21);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(ids()).toEqual([30]);
  });

  it("用户滚动滚轮后，后续批次不再定位", () => {
    open(30);
    const { container } = render(<GridView />);
    add(1, 30);
    scrollToIndex.mockClear();
    fireEvent.wheel(container.querySelector(".grid-scroll")!, { deltaY: 40 });
    add(1, 1, 2, 3);
    expect(scrollToIndex).not.toHaveBeenCalled();
    done(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("用户在滚动区按下指针后，后续批次不再定位", () => {
    open(30);
    const { container } = render(<GridView />);
    add(1, 30);
    scrollToIndex.mockClear();
    fireEvent.pointerDown(container.querySelector('[data-id="30"]')!, { button: 0, clientX: 10 });
    add(1, 1, 2, 3);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("用户选了别的图（例如键盘），后续批次不再定位，也不重新选中", () => {
    open(30);
    render(<GridView />);
    add(1, 30, 40);
    scrollToIndex.mockClear();
    act(() => useSelection.getState().set(selectOnly(40)));
    add(1, 1, 2, 3);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(ids()).toEqual([40]);
    act(() => useSelection.getState().set(selectOnly(30)));
    add(1, 4);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("打开图片文件（非恢复）：选中、定位并进入单张视图", () => {
    open(3);
    render(<GridView />);
    add(1, 1, 2, 3);
    expect(ids()).toEqual([3]);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
  });

  it("从最近目录恢复：只在网格里选中并定位，不进入单张视图", () => {
    open(3, 1, true);
    render(<GridView />);
    add(1, 1, 2, 3);
    expect(ids()).toEqual([3]);
    expect(revealedTo(3)).toBe(true);
    expect(topView().kind).toBe("grid");
  });

  it("视图重新挂载（例如切换语言）不会把同一次打开的 focus 再处理一遍", () => {
    open(3);
    const { rerender } = render(<GridView key="a" />);
    add(1, 1, 2, 3);
    expect(topView().kind).toBe("single");
    act(() => useNav.getState().back());
    act(() => useSelection.getState().set(selectOnly(1)));
    scrollToIndex.mockClear();
    rerender(<GridView key="b" />);
    expect(topView().kind).toBe("grid");
    expect(ids()).toEqual([1]);
    expect(scrollToIndex).not.toHaveBeenCalled();
    // 新的一次打开（新的 generation）照常处理
    open(2, 2);
    add(2, 1, 2);
    expect(ids()).toEqual([2]);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
  });

  it("打开目录（无 focus）不自动选中", () => {
    open(null);
    render(<GridView />);
    add(1, 1, 2);
    expect(ids()).toEqual([]);
  });

  it("挂载期间注册网格命令，卸载后注销", async () => {
    const { allCommands } = await import("../../app/commands");
    open(null);
    const { unmount } = render(<GridView />);
    expect(allCommands().some((c) => c.id === "nav.right")).toBe(true);
    unmount();
    expect(allCommands().some((c) => c.id === "nav.right")).toBe(false);
  });

  it("点空白处清空选中；点格子、标题或滚动条不清空", () => {
    open(null);
    const { container } = render(<GridView />);
    add(1, 1, 2);
    const scroller = container.querySelector(".grid-scroll") as HTMLElement;
    act(() => useSelection.getState().set(selectOnly(1)));

    fireEvent.pointerDown(scroller, { button: 0, clientX: 650 }); // 滚动条在 clientWidth 之外
    expect(ids()).toEqual([1]);
    fireEvent.pointerDown(container.querySelector(".group-header")!, { button: 0, clientX: 10 });
    expect(ids()).toEqual([1]);
    fireEvent.pointerDown(scroller, { button: 2, clientX: 10 });
    expect(ids()).toEqual([1]);

    // 按在格子上：冒泡到滚动区也不清空，格子与焦点的 class 随之更新
    fireEvent.pointerDown(container.querySelector('[data-id="2"]')!, { button: 0, clientX: 10 });
    expect(ids()).toEqual([2]);
    const cell2 = container.querySelector('[data-id="2"]')!;
    expect(cell2.classList.contains("thumb-selected")).toBe(true);
    expect(cell2.classList.contains("thumb-focused")).toBe(true);
    expect(container.querySelector('[data-id="1"]')!.classList.contains("thumb-selected")).toBe(false);

    fireEvent.pointerDown(scroller, { button: 0, clientX: 10 });
    expect(ids()).toEqual([]);
  });

  describe("框选", () => {
    // 滚动区在视口 (0,0)–(600,400)，内容区左边距 GRID_PAD（16）；cell 160 → 内容区宽 568、3 列。
    // 根组 2 张：标题 y∈[0,32)，格子 1 在内容区 x∈[0,160]、格子 2 在 x∈[168,328]，y∈[32,216]。
    let frames: FrameRequestCallback[] = [];
    const flush = () => act(() => {
      const run = frames;
      frames = [];
      for (const f of run) f(0);
    });

    beforeEach(() => {
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
      vi.stubGlobal("cancelAnimationFrame", () => {});
      const rect = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0 };
      const gbcr = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
      restore.push(() => { Element.prototype.getBoundingClientRect = gbcr; });
      const proto = Element.prototype as unknown as Record<string, unknown>;
      const had = { set: proto.setPointerCapture, rel: proto.releasePointerCapture };
      proto.setPointerCapture = vi.fn();
      proto.releasePointerCapture = vi.fn();
      restore.push(() => { proto.setPointerCapture = had.set; proto.releasePointerCapture = had.rel; });
      // jsdom 没有 elementFromPoint；在格子上按下拖动会开始缩略图拖拽，松手时它要按指针位置找落点
      const doc = document as unknown as Record<string, unknown>;
      const hadEfp = doc.elementFromPoint;
      doc.elementFromPoint = () => null;
      restore.push(() => { doc.elementFromPoint = hadEfp; });
      useListView.setState({ cell: 160 });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const setup = () => {
      open(null);
      const { container, rerender } = render(<GridView />);
      add(1, 1, 2);
      const scroller = container.querySelector(".grid-scroll") as HTMLElement;
      return { container, scroller, rerender };
    };
    const marquee = (container: HTMLElement) => container.querySelector(".grid-marquee");

    it("按下后不移动就松开：清空选中，不画框", () => {
      const { container, scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 502, clientY: 102 }); // 不超过 4 px
      flush();
      fireEvent.pointerUp(scroller, { clientX: 502, clientY: 102 });
      flush();
      expect(ids()).toEqual([]);
      expect(marquee(container)).toBeNull();
    });

    it("拖动超过 4 px 后选中矩形碰到的格子，松开后框消失、选中保留", () => {
      const { container, scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 }); // 内容区 x 184..484 → 只碰到格子 2
      flush();
      expect(ids()).toEqual([2]);
      expect(useSelection.getState().focus).toBe(2);
      const box = marquee(container) as HTMLElement;
      expect(box).not.toBeNull();
      // 内容区坐标画在画布里：left = GRID_PAD + 184
      expect(box.style.left).toBe(`${GRID_PAD + 184}px`);
      expect(box.style.top).toBe("60px");
      expect(box.style.width).toBe("300px");
      expect(box.style.height).toBe("40px");

      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 100, clientY: 60 }); // 扩大到格子 1，还没到下一帧就松开
      fireEvent.pointerUp(scroller, { clientX: 100, clientY: 60 });
      flush();
      expect(ids()).toEqual([1, 2]);
      expect(marquee(container)).toBeNull();
    });

    it("同一帧内多次移动只更新一次选中", () => {
      const { scroller } = setup();
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      const set = vi.spyOn(useSelection.getState(), "set");
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 300, clientY: 60 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      expect(set).not.toHaveBeenCalled();
      flush();
      expect(set).toHaveBeenCalledTimes(1);
      expect(ids()).toEqual([2]);
    });

    it("按着 Mod 或 Shift 框选时加到原选中上；不移动则不清空", () => {
      const { scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100, metaKey: true });
      fireEvent.pointerUp(scroller, { clientX: 500, clientY: 100 });
      flush();
      expect(ids()).toEqual([1]);

      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100, metaKey: true });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([1, 2]);
      fireEvent.pointerUp(scroller, { clientX: 200, clientY: 60 });

      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100, shiftKey: true });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([1, 2]);
      fireEvent.pointerUp(scroller, { clientX: 200, clientY: 60 });
    });

    it("拖动中按 Esc：恢复按下时的选中，框消失，不再触发清空选中命令", () => {
      const { container, scroller } = setup();
      window.addEventListener("keydown", handleKeyDown);
      restore.push(() => window.removeEventListener("keydown", handleKeyDown));
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([2]);

      fireEvent.keyDown(scroller, { key: "Escape" });
      flush();
      expect(ids()).toEqual([1]);
      expect(useSelection.getState().focus).toBe(1);
      expect(marquee(container)).toBeNull();
      // 拖动已结束：之后的移动与松开不再改变选中，下一次 Esc 照常清空
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 100, clientY: 60 });
      fireEvent.pointerUp(scroller, { clientX: 100, clientY: 60 });
      flush();
      expect(ids()).toEqual([1]);
      fireEvent.keyDown(scroller, { key: "Escape" });
      expect(ids()).toEqual([]);
    });

    const remove = (...idList: number[]) => {
      act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: idList }));
    };

    it("按着 Mod 框选途中，原先选中的一张被移除：框选结果里不再有它", () => {
      const { scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100, metaKey: true });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([1, 2]);

      remove(1);
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 150, clientY: 60 });
      flush();
      expect(ids()).not.toContain(1);
      expect(useSelection.getState().focus).toBe(2);
      expect(useSelection.getState().anchor).toBe(2);
      fireEvent.pointerUp(scroller, { clientX: 150, clientY: 60 });
    });

    it("框选途中原先选中的一张被移除后按 Esc：恢复的选中里不再有它", () => {
      const { scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([2]);

      remove(1);
      fireEvent.keyDown(scroller, { key: "Escape" });
      expect(ids()).not.toContain(1);
      expect(useSelection.getState().focus).toBe(2);
      expect(useSelection.getState().anchor).toBe(2);
    });

    it("框选途中焦点所在的图被移除后按 Esc：恢复的选中里没有它，焦点落到按下时列表里它后面最近的仍存在的图", () => {
      open(null);
      const { scroller } = (() => {
        const { container } = render(<GridView />);
        add(1, 1, 2, 3);
        return { scroller: container.querySelector(".grid-scroll") as HTMLElement };
      })();
      act(() => useSelection.getState().set({ ids: new Set([1, 2]), focus: 2, anchor: 2 }));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      remove(2);
      fireEvent.keyDown(scroller, { key: "Escape" });
      expect(ids()).toEqual([1]);
      expect(useSelection.getState().focus).toBe(3);
      expect(useSelection.getState().anchor).toBe(3);
    });

    it("缩略图拖拽进行中，另一个指针在空白处按下：选中不变，不出现框选矩形", () => {
      const { container, scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      act(() => useDrag.setState({ count: 1, copy: false, target: null }));
      restore.push(() => useDrag.setState({ count: 0, copy: false, target: null }));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([1]);
      expect(marquee(container)).toBeNull();
    });

    it("网格被单张视图盖住（hidden）时结束进行中的框选，之后的 Esc 不再被框选拦下", () => {
      const { container, scroller, rerender } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([2]);
      rerender(<GridView hidden />);
      expect(container.querySelector(".grid-view")!.classList.contains("grid-hidden")).toBe(true);
      expect(container.querySelector(".grid-scroll")).toBe(scroller); // 不卸载，滚动区原样保留
      expect(marquee(container)).toBeNull();
      const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      act(() => { window.dispatchEvent(esc); });
      expect(esc.defaultPrevented).toBe(false);
      expect(ids()).toEqual([2]);
      // 隐藏期间在滚动区按下也不开始框选、不清空选中
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      expect(ids()).toEqual([2]);
    });

    it("不按 Mod/Shift 拖动、矩形只落在空白处：选中为空，focus 与 anchor 为 null", () => {
      const { container, scroller } = setup();
      act(() => useSelection.getState().set(selectOnly(1)));
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 490, clientY: 110 }); // 内容区 x 478..488，第三列空着
      flush();
      expect(marquee(container)).not.toBeNull();
      expect(ids()).toEqual([]);
      expect(useSelection.getState().focus).toBeNull();
      expect(useSelection.getState().anchor).toBeNull();
    });

    it("漏掉松开时（移动时主键已不在按下状态，或失去指针捕获）结束框选", () => {
      const { container, scroller } = setup();
      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(ids()).toEqual([2]);
      fireEvent.pointerMove(scroller, { buttons: 0, clientX: 100, clientY: 60 });
      flush();
      expect(marquee(container)).toBeNull();
      expect(ids()).toEqual([2]);

      fireEvent.pointerDown(scroller, { button: 0, clientX: 500, clientY: 100 });
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 200, clientY: 60 });
      flush();
      expect(marquee(container)).not.toBeNull();
      fireEvent(scroller, new Event("lostpointercapture"));
      flush();
      expect(marquee(container)).toBeNull();
      fireEvent.pointerMove(scroller, { buttons: 1, clientX: 100, clientY: 60 });
      flush();
      expect(ids()).toEqual([2]);
    });

    describe("边缘自动滚动", () => {
      // 30 张 → 10 行，总高 1944；视口高 400 → scrollTop 最大 1544。scrollTop 写入时像引擎一样舍去小数并夹紧
      const setupTall = (initial: number) => {
        open(null);
        const { container } = render(<GridView />);
        add(1, ...Array.from({ length: 30 }, (_, i) => i + 1));
        const scroller = container.querySelector(".grid-scroll") as HTMLElement;
        let top = initial;
        Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1944 });
        Object.defineProperty(scroller, "scrollTop", {
          configurable: true,
          get: () => top,
          set: (v: number) => { top = Math.min(1544, Math.max(0, Math.floor(v))); },
        });
        return { scroller, top: () => top };
      };

      it("指针停在下边缘带外侧（速度不足 1 px/帧）：多帧后仍在前进，选中随之扩大", () => {
        const { scroller, top } = setupTall(0);
        fireEvent.pointerDown(scroller, { button: 0, clientX: 520, clientY: 100 }); // 内容区 x 508，第三列右侧空白
        fireEvent.pointerMove(scroller, { buttons: 1, clientX: 100, clientY: 377 }); // 离下边缘 23 px → 2/3 px/帧
        flush();
        const firstCount = ids().length;
        for (let i = 0; i < 60; i++) flush();
        expect(top()).toBeGreaterThanOrEqual(39);
        expect(ids().length).toBeGreaterThan(firstCount);
        expect(frames.length).toBe(1); // 还在继续
      });

      it("滚到底后循环停止", () => {
        const { scroller, top } = setupTall(1530);
        fireEvent.pointerDown(scroller, { button: 0, clientX: 520, clientY: 100 });
        fireEvent.pointerMove(scroller, { buttons: 1, clientX: 100, clientY: 399 });
        for (let i = 0; i < 5 && frames.length > 0; i++) flush();
        expect(top()).toBe(1544);
        expect(frames.length).toBe(0);
        expect(ids()).toContain(30); // 最后一行也被框进来
      });
    });

    it("在格子、标题、滚动条上按下或用右键都不开始框选", () => {
      const { container, scroller } = setup();
      const starts: [Element, number, number][] = [
        [container.querySelector('[data-id="2"]')!, 0, 250],
        [container.querySelector(".group-header")!, 0, 300],
        [scroller, 0, 650],
        [scroller, 2, 500],
      ];
      for (const [el, button, clientX] of starts) {
        act(() => useSelection.getState().set(selectOnly(1)));
        fireEvent.pointerDown(el, { button, clientX, clientY: 100 });
        fireEvent.pointerMove(scroller, { buttons: 1, clientX: 20, clientY: 60 });
        flush();
        expect(marquee(container)).toBeNull();
        fireEvent.pointerUp(scroller, { clientX: 20, clientY: 60 });
      }
    });
  });
});
