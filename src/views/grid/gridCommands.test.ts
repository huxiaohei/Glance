import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allCommands } from "../../app/commands";
import type { ImageList } from "../../lib/deriveList";
import { layoutGrid } from "../../lib/gridLayout";
import { selectOnly } from "../../lib/selection";
import { useGridCtx } from "../../stores/gridCtx";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { registerGridCommands } from "./gridCommands";

vi.mock("../../ipc/api");

// 两组各三张；两列：[1 2] [3] | [4 5] [6]
const list: ImageList = {
  ids: [1, 2, 3, 4, 5, 6],
  groups: [
    { dir: "", start: 0, count: 3, total: 3 },
    { dir: "sub", start: 3, count: 3, total: 3 },
  ],
};
const layout = layoutGrid(list, 208, 100);
const reveal = vi.fn();

const run = (id: string, shift = false, repeat = false) => {
  const cmd = allCommands().find((c) => c.id === id);
  if (!cmd) throw new Error(`no command ${id}`);
  cmd.run({ shift, repeat });
};
const ids = () => [...useSelection.getState().ids].sort((a, b) => a - b);

let off = () => {};
beforeEach(() => {
  useGridCtx.setState({ list, layout, reveal });
  useSelection.getState().clear();
  reveal.mockClear();
  off = registerGridCommands();
});
afterEach(() => off());

describe("gridCommands", () => {
  it("注册的命令只在网格视图生效，输入框内不触发", () => {
    const mine = allCommands().filter((c) => c.id.startsWith("nav.") || c.id.startsWith("select."));
    expect(mine.map((c) => c.id).sort()).toEqual(
      ["nav.down", "nav.end", "nav.home", "nav.left", "nav.right", "nav.up", "select.all", "select.clear"],
    );
    for (const c of mine) {
      expect(c.views).toEqual(["grid"]);
      expect(c.allowInInput).toBeFalsy();
    }
    expect(allCommands().find((c) => c.id === "nav.left")!.keys).toEqual(["ArrowLeft", "Shift+ArrowLeft"]);
  });

  it("注销后命令消失", () => {
    off();
    off = () => {};
    expect(allCommands().some((c) => c.id === "nav.left")).toBe(false);
  });

  it("没有焦点时按方向键，焦点落到第一张", () => {
    run("nav.down");
    const s = useSelection.getState();
    expect(s.focus).toBe(1);
    expect(ids()).toEqual([1]);
    expect(reveal).toHaveBeenCalledWith(1);
  });

  it("右键移动焦点并只选中它，同时调用 reveal", () => {
    useSelection.getState().set(selectOnly(3));
    run("nav.right");
    expect(useSelection.getState().focus).toBe(4);
    expect(ids()).toEqual([4]);
    expect(reveal).toHaveBeenCalledWith(4);
  });

  it("上下按列移动，跨分组；Home / End 到首尾", () => {
    useSelection.getState().set(selectOnly(2));
    run("nav.down");
    expect(useSelection.getState().focus).toBe(3);
    run("nav.down");
    expect(useSelection.getState().focus).toBe(4);
    run("nav.end");
    expect(useSelection.getState().focus).toBe(6);
    run("nav.home");
    expect(useSelection.getState().focus).toBe(1);
  });

  it("Shift + 下 从锚点扩展选中", () => {
    useSelection.getState().set(selectOnly(1));
    run("nav.down", true);
    const s = useSelection.getState();
    expect(s.focus).toBe(3);
    expect(s.anchor).toBe(1);
    expect(ids()).toEqual([1, 2, 3]);
  });

  it("焦点不在当前布局里（被筛掉或折叠）时落到第一张", () => {
    useSelection.getState().set(selectOnly(99));
    run("nav.left");
    expect(useSelection.getState().focus).toBe(1);
  });

  it("列表为空时什么都不做", () => {
    const empty: ImageList = { ids: [], groups: [] };
    useGridCtx.setState({ list: empty, layout: layoutGrid(empty, 208, 100) });
    run("nav.right");
    expect(useSelection.getState().focus).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("Mod+A 先选当前组再选全部", () => {
    useSelection.getState().set(selectOnly(5));
    run("select.all");
    expect(ids()).toEqual([4, 5, 6]);
    run("select.all");
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(allCommands().find((c) => c.id === "select.all")!.keys).toEqual(["Mod+A"]);
  });

  it("Esc 清空选中", () => {
    useSelection.getState().set(selectOnly(2));
    run("select.clear");
    const s = useSelection.getState();
    expect(s.ids.size).toBe(0);
    expect(s.focus).toBeNull();
    expect(allCommands().find((c) => c.id === "select.clear")!.keys).toEqual(["Escape"]);
  });

  it("按住 Esc 的自动重复不清空选中", () => {
    useSelection.getState().set(selectOnly(2));
    run("select.clear", false, true);
    expect(ids()).toEqual([2]);
  });

  it("焦点所在分组已折叠时回车不打开单张视图", () => {
    useNav.getState().reset();
    // sub 组折叠：它的项不在列表里
    const collapsed: ImageList = {
      ids: [1, 2, 3],
      groups: [
        { dir: "", start: 0, count: 3, total: 3 },
        { dir: "sub", start: 3, count: 0, total: 3 },
      ],
    };
    useGridCtx.setState({ list: collapsed, layout: layoutGrid(collapsed, 208, 100) });
    useSelection.getState().set(selectOnly(5));
    run("grid.open");
    expect(topView()).toEqual({ kind: "grid" });
    // 对照：焦点在展开的分组里时打开
    useSelection.getState().set(selectOnly(2));
    run("grid.open");
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    useNav.getState().reset();
  });
});
