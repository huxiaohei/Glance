import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RootInfo } from "../ipc/types";
import { useCatalog } from "./catalog";
import { useSelection } from "./selection";
import { useListView } from "./listView";
import { selectOnly, toggle } from "../lib/selection";

const root = (generation: number, path = "/r"): RootInfo => ({ generation, path, name: "r", recursive: true, focus: null });
const w = (id: number) => ({ id, relPath: `${id}.png`, size: 1, mtimeMs: 1 });

beforeEach(() => {
  useCatalog.getState().reset();
  useListView.getState().setDirFilter(null);
  useSelection.getState().clear();
});

describe("selection store", () => {
  it("catalog 移除条目后选中集合自动修剪", () => {
    const c = useCatalog.getState();
    c.begin(root(1));
    c.apply({ type: "batch", generation: 1, entries: [w(1), w(2), w(3)] });
    useSelection.getState().set(toggle(toggle(selectOnly(1), 2), 3));
    c.apply({ type: "removed", generation: 1, ids: [2, 3] });
    const s = useSelection.getState();
    expect([...s.ids]).toEqual([1]);
    expect(s.focus).toBeNull();
  });
  it("修剪直接查条目表，不另建 id 集合", () => {
    const c = useCatalog.getState();
    c.begin(root(1));
    c.apply({ type: "batch", generation: 1, entries: [w(1), w(2)] });
    useSelection.getState().set(toggle(selectOnly(1), 2));
    const spy = vi.spyOn(Map.prototype, "keys");
    c.apply({ type: "removed", generation: 1, ids: [2] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect([...useSelection.getState().ids]).toEqual([1]);
  });
  it("目录树选中的目录被删除或改名后回到“全部图片”", () => {
    const c = useCatalog.getState();
    c.begin(root(1));
    c.apply({ type: "batch", generation: 1, entries: [
      { id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 },
      { id: 2, relPath: "a/b/y.png", size: 1, mtimeMs: 1 },
      { id: 3, relPath: "c/z.png", size: 1, mtimeMs: 1 },
      { id: 4, relPath: "top.png", size: 1, mtimeMs: 1 },
    ] });
    const lv = useListView.getState();
    lv.setDirFilter("a");
    c.apply({ type: "removed", generation: 1, ids: [1] });
    expect(useListView.getState().dirFilter).toBe("a");   // 子目录下还有
    c.apply({ type: "removed", generation: 1, ids: [2] });
    expect(useListView.getState().dirFilter).toBeNull();
    lv.setDirFilter("c");
    c.apply({ type: "renamed", generation: 1, items: [{ id: 3, relPath: "d/z.png" }] });
    expect(useListView.getState().dirFilter).toBeNull();
    // 根目录（""）始终保留
    lv.setDirFilter("");
    c.apply({ type: "removed", generation: 1, ids: [3] });
    expect(useListView.getState().dirFilter).toBe("");
  });
  it("换目录清空选中，刷新同一目录不清空", () => {
    const c = useCatalog.getState();
    c.begin(root(1));
    c.apply({ type: "batch", generation: 1, entries: [w(1)] });
    useSelection.getState().set(selectOnly(1));
    c.begin(root(2), { keep: true });
    expect([...useSelection.getState().ids]).toEqual([1]);
    c.apply({ type: "batch", generation: 2, entries: [w(1)] });
    c.apply({ type: "done", generation: 2, total: 1 });
    expect([...useSelection.getState().ids]).toEqual([1]);
    c.begin(root(3, "/other"));
    expect(useSelection.getState().ids.size).toBe(0);
    expect(useSelection.getState().focus).toBeNull();
  });
});
