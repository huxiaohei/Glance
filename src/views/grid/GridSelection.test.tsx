// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { ImageEntry, ImageList } from "../../lib/deriveList";
import { layoutGrid } from "../../lib/gridLayout";
import { selectOnly } from "../../lib/selection";
import { useCatalog } from "../../stores/catalog";
import { useGridCtx } from "../../stores/gridCtx";
import { useListView } from "../../stores/listView";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import GridView from "./GridView";
import GroupHeader from "./GroupHeader";
import ThumbCell from "./ThumbCell";

vi.mock("../../ipc/api");
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
  const add = (generation: number, ...idList: number[]) => {
    act(() => {
      useCatalog.getState().apply({
        type: "batch",
        generation,
        entries: idList.map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
      });
    });
  };

  it("打开单张图片：条目到达后选中并定位，同一次打开只做一次", () => {
    open(3);
    render(<GridView />);
    add(1, 1, 2);
    expect(ids()).toEqual([]);
    add(1, 3);
    expect(ids()).toEqual([3]);
    expect(useSelection.getState().focus).toBe(3);
    expect(useGridCtx.getState().list.ids).toEqual([1, 2, 3]);

    act(() => useSelection.getState().set(selectOnly(1)));
    add(1, 4);
    expect(ids()).toEqual([1]);
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
});
