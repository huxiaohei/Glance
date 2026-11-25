import { beforeEach, describe, expect, it } from "vitest";
import type { RootInfo } from "../ipc/types";
import { useCatalog } from "./catalog";
import { topView, useNav } from "./nav";

const root = (generation: number, path = "/r"): RootInfo => ({ generation, path, name: "r", recursive: true, focus: null });

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
});

describe("nav store", () => {
  it("openSingle 压栈；再次 openSingle 只换 id，栈深仍为 2", () => {
    expect(topView()).toEqual({ kind: "grid" });
    useNav.getState().openSingle(3);
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }, { kind: "single", source: "folder", id: 3 }]);
    useNav.getState().openSingle(5);
    expect(useNav.getState().stack).toHaveLength(2);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 5 });

    useNav.getState().setCurrent(7);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 7 });
  });

  it("back 回到网格；只剩网格时 back 不变（返回原状态对象）", () => {
    useNav.getState().openSingle(3);
    useNav.getState().back();
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }]);
    const before = useNav.getState();
    useNav.getState().back();
    expect(useNav.getState()).toBe(before);
    // 栈顶不是 single 时 setCurrent 不做事
    useNav.getState().setCurrent(9);
    expect(useNav.getState()).toBe(before);
  });

  it("换目录时栈复位", () => {
    useCatalog.getState().begin(root(1, "/a"));
    useNav.getState().openSingle(3);
    // 刷新同一目录（新 generation、同一路径）不复位
    useCatalog.getState().begin(root(2, "/a"), { keep: true });
    expect(topView().kind).toBe("single");
    useCatalog.getState().begin(root(3, "/b"));
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }]);

    useNav.getState().openSingle(4);
    useCatalog.getState().reset();
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }]);
  });

  it("openCompare 压栈；basket 来源的单张上 openCompare 等同 back；已是 compare 时不变", () => {
    useNav.getState().openCompare();
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }, { kind: "compare" }]);
    useNav.getState().openSingle(4, "basket");
    expect(topView()).toEqual({ kind: "single", source: "basket", id: 4 });
    useNav.getState().setCurrent(6);
    expect(topView()).toEqual({ kind: "single", source: "basket", id: 6 });
    useNav.getState().openCompare();
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }, { kind: "compare" }]);
    const before = useNav.getState();
    useNav.getState().openCompare();
    expect(useNav.getState()).toBe(before);
    useNav.getState().reset();
    expect(useNav.getState().stack).toEqual([{ kind: "grid" }]);
  });

  it("folder 来源的单张上 openCompare 压栈；openSingle 默认 folder 来源", () => {
    useNav.getState().openSingle(3);
    useNav.getState().openCompare();
    expect(useNav.getState().stack).toEqual([
      { kind: "grid" },
      { kind: "single", source: "folder", id: 3 },
      { kind: "compare" },
    ]);
    useNav.getState().back();
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
  });
});
