import { beforeEach, describe, expect, it } from "vitest";
import type { RootInfo } from "../ipc/types";
import { useCatalog } from "./catalog";
import { useSelection } from "./selection";
import { selectOnly, toggle } from "../lib/selection";

const root = (generation: number, path = "/r"): RootInfo => ({ generation, path, name: "r", recursive: true, focus: null });
const w = (id: number) => ({ id, relPath: `${id}.png`, size: 1, mtimeMs: 1 });

beforeEach(() => {
  useCatalog.getState().reset();
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
