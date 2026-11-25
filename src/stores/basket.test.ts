import { beforeEach, describe, expect, it } from "vitest";
import type { RootInfo } from "../ipc/types";
import { basketItem, useBasket } from "./basket";
import { useCatalog } from "./catalog";
import { useToast } from "./toast";

const root = (generation: number, path = "/r"): RootInfo => ({ generation, path, name: "r", recursive: true, focus: null });
const w = (id: number, relPath = `${id}.png`) => ({ id, relPath, size: 1, mtimeMs: 1 });
const load = (ids: number[], path = "/r", gen = 1) => {
  const c = useCatalog.getState();
  c.begin(root(gen, path));
  c.apply({ type: "batch", generation: gen, entries: ids.map((i) => w(i)) });
  c.apply({ type: "done", generation: gen, total: ids.length });
};

beforeEach(() => {
  useCatalog.getState().reset();
  useBasket.setState({ order: [], items: new Map(), missing: new Set() });
  useToast.setState({ current: null });
});

describe("basket store", () => {
  it("toggle 后有快照，dirName 取根名或最后一段", () => {
    const c = useCatalog.getState();
    c.begin(root(1));
    c.apply({ type: "batch", generation: 1, entries: [w(1), w(2, "a/b/2.png")] });
    useBasket.getState().toggle([1, 2, 99]);
    const s = useBasket.getState();
    expect(s.order).toEqual([1, 2]);
    expect(s.items.get(1)?.dirName).toBe("r");
    expect(s.items.get(2)?.dirName).toBe("b");
  });
  it("换目录后保持不变", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    load([5], "/other", 2);
    const s = useBasket.getState();
    expect(s.order).toEqual([1, 2]);
    expect(s.items.size).toBe(2);
    expect(s.missing.size).toBe(0);
  });
  it("当前目录 removed 后进 missing 但仍在 order", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] });
    const s = useBasket.getState();
    expect(s.order).toEqual([1, 2]);
    expect([...s.missing]).toEqual([1]);
  });
  it("renamed 后 basketItem 取新名", () => {
    load([1]);
    useBasket.getState().toggle([1]);
    useCatalog.getState().apply({ type: "renamed", generation: 1, items: [{ id: 1, relPath: "new.png" }] });
    expect(basketItem(1)?.name).toBe("new.png");
    expect(useBasket.getState().items.get(1)?.name).toBe("new.png");
  });
  it("basketItem 不在当前目录时用快照", () => {
    load([1]);
    useBasket.getState().toggle([1]);
    load([5], "/other", 2);
    expect(basketItem(1)?.name).toBe("1.png");
    expect(basketItem(42)).toBeUndefined();
  });
  it("越过 100 张只提示一次", () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    load(ids);
    useBasket.getState().toggle(ids.slice(0, 100));
    expect(useToast.getState().current).toBeNull();
    useBasket.getState().toggle([101]);
    const first = useToast.getState().current;
    expect(first).not.toBeNull();
    useToast.setState({ current: null });
    load([...ids, 102]);
    useBasket.getState().toggle([102]);
    expect(useToast.getState().current).toBeNull();
  });
  it("remove 后 restore 回到原顺序", () => {
    load([1, 2, 3]);
    useBasket.getState().toggle([1, 2, 3]);
    const snap = useBasket.getState().remove([2]);
    expect(useBasket.getState().order).toEqual([1, 3]);
    expect(useBasket.getState().items.has(2)).toBe(false);
    useBasket.getState().restore(snap);
    expect(useBasket.getState().order).toEqual([1, 2, 3]);
    expect(useBasket.getState().items.has(2)).toBe(true);
  });
  it("clear 返回快照", () => {
    load([1]);
    useBasket.getState().toggle([1]);
    const snap = useBasket.getState().clear();
    expect(snap.order).toEqual([1]);
    expect(useBasket.getState().order).toEqual([]);
  });
  it("applyCheck：null 缺失，有值刷新快照并移出缺失", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    useBasket.getState().applyCheck(
      [null, { id: 2, name: "x.png", dirName: "r", size: 9, mtimeMs: 9, w: 10, h: 20 }],
      [1, 2],
    );
    let s = useBasket.getState();
    expect([...s.missing]).toEqual([1]);
    expect(s.items.get(2)).toMatchObject({ name: "x.png", size: 9, width: 10, height: 20 });
    useBasket.getState().applyCheck([{ id: 1, name: "1.png", dirName: "r", size: 1, mtimeMs: 1, w: null, h: null }], [1]);
    s = useBasket.getState();
    expect(s.missing.size).toBe(0);
  });
});
