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
  it("restore 带回缺失标记", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] });
    expect(useBasket.getState().missing.has(1)).toBe(true);
    const snap = useBasket.getState().remove([1]);
    expect(useBasket.getState().missing.has(1)).toBe(false);
    useBasket.getState().restore(snap);
    expect(useBasket.getState().missing.has(1)).toBe(true);
    const snap2 = useBasket.getState().clear();
    useBasket.getState().restore(snap2);
    expect(useBasket.getState().missing.has(1)).toBe(true);
  });
  it("撤销清空不吞掉清空后新加的图：放回原位置，新加的保留", () => {
    load([1, 2, 3, 4]);
    useBasket.getState().toggle([1, 2, 3]);
    const snap = useBasket.getState().clear();
    useBasket.getState().toggle([4]);
    useBasket.getState().restore(snap);
    const s = useBasket.getState();
    expect(s.order).toEqual([1, 2, 3, 4]);
    expect([...s.items.keys()].sort()).toEqual([1, 2, 3, 4]);
  });
  it("撤销移出只放回被移出的，按旧位置插进当前顺序", () => {
    load([1, 2, 3, 4, 5]);
    useBasket.getState().toggle([1, 2, 3]);
    const snap = useBasket.getState().remove([2]);
    useBasket.getState().toggle([3]);
    useBasket.getState().toggle([5]);
    useBasket.getState().restore(snap);
    const s = useBasket.getState();
    // 3 是撤销前另外移出的（不是这次移出的），不放回；2 回到旧下标 1，5 保留
    expect(s.order).toEqual([1, 2, 5]);
    expect(s.items.has(3)).toBe(false);
    expect(s.items.has(2)).toBe(true);
  });
  it("刷新同一目录：消失的条目在 done 时才标缺失", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    const c = useCatalog.getState();
    c.begin(root(2), { keep: true });
    c.apply({ type: "batch", generation: 2, entries: [w(2)] });
    expect(useBasket.getState().missing.size).toBe(0);
    c.apply({ type: "done", generation: 2, total: 1 });
    expect([...useBasket.getState().missing]).toEqual([1]);
  });
  it("扫描中不标缺失，done 后才标", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    const c = useCatalog.getState();
    c.begin(root(2), { keep: true });
    expect(useCatalog.getState().scanning).toBe(true);
    c.apply({ type: "removed", generation: 2, ids: [1] });
    expect(useBasket.getState().missing.size).toBe(0);
    c.apply({ type: "batch", generation: 2, entries: [w(2)] });
    c.apply({ type: "done", generation: 2, total: 1 });
    expect([...useBasket.getState().missing]).toEqual([1]);
  });
  it("回到原目录：条目重现则移出缺失并刷新快照", () => {
    load([1, 2]);
    useBasket.getState().toggle([1, 2]);
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] });
    expect(useBasket.getState().missing.has(1)).toBe(true);
    load([5], "/other", 2);
    const c = useCatalog.getState();
    c.begin(root(3));
    c.apply({ type: "batch", generation: 3, entries: [{ id: 1, relPath: "1.png", size: 9, mtimeMs: 7 }, w(2)] });
    c.apply({ type: "done", generation: 3, total: 2 });
    const s = useBasket.getState();
    expect(s.missing.size).toBe(0);
    expect(s.items.get(1)).toMatchObject({ size: 9, mtimeMs: 7 });
  });
});

describe("basket store: 排序、跨目录加入与恢复", () => {
  const seed = (ids: number[]) => {
    load(ids);
    useBasket.getState().toggle(ids);
  };
  it("move 前移", () => {
    seed([1, 2, 3, 4]);
    useBasket.getState().move(4, 0);
    expect(useBasket.getState().order).toEqual([4, 1, 2, 3]);
  });
  it("move 后移", () => {
    seed([1, 2, 3, 4]);
    useBasket.getState().move(1, 2);
    expect(useBasket.getState().order).toEqual([2, 3, 1, 4]);
  });
  it("move 越界夹到末尾；不在篮里或位置不变不产生新状态", () => {
    seed([1, 2, 3]);
    useBasket.getState().move(1, 99);
    expect(useBasket.getState().order).toEqual([2, 3, 1]);
    const before = useBasket.getState();
    useBasket.getState().move(77, 0);
    expect(useBasket.getState()).toBe(before);
    useBasket.getState().move(2, 0);
    expect(useBasket.getState()).toBe(before);
  });
  it("swap 交换两张", () => {
    seed([1, 2, 3]);
    useBasket.getState().swap(1, 3);
    expect(useBasket.getState().order).toEqual([3, 2, 1]);
  });
  it("toggleItems keeps snapshot outside catalog", () => {
    const item = { id: 8, name: "x.png", dirName: "other", size: 5, mtimeMs: 6, width: 1, height: 2 };
    useBasket.getState().toggleItems([item]);
    expect(useBasket.getState().order).toEqual([8]);
    expect(basketItem(8)).toEqual(item);
    useBasket.getState().toggleItems([item]);
    expect(useBasket.getState().order).toEqual([]);
    expect(useBasket.getState().items.has(8)).toBe(false);
  });
  const entry = (id: number) => ({ id, name: `${id}.png`, dirName: "d", size: 1, mtimeMs: 2, w: null, h: null });
  const rest = (id: number, withEntry = true) => ({ id, name: `${id}.png`, dirName: "d", entry: withEntry ? entry(id) : null });
  it("hydrate 合并：恢复的在前，已有的去重后接后面", () => {
    useBasket.setState({ order: [5], items: new Map([[5, { id: 5, name: "5.png", dirName: "d", size: 1, mtimeMs: 1 }]]) });
    useBasket.getState().hydrate([rest(3), rest(5), rest(4)]);
    expect(useBasket.getState().order).toEqual([3, 5, 4]);
    useBasket.setState({ order: [9], items: new Map([[9, { id: 9, name: "9.png", dirName: "d", size: 1, mtimeMs: 1 }]]) });
    useBasket.getState().hydrate([rest(3), rest(5), rest(4)]);
    expect(useBasket.getState().order).toEqual([3, 5, 4, 9]);
  });
  it("hydrate 缺失条目进 missing，快照取名字", () => {
    useBasket.getState().hydrate([rest(3), rest(4, false)]);
    const s = useBasket.getState();
    expect(s.missing.has(4)).toBe(true);
    expect(s.missing.has(3)).toBe(false);
    expect(s.items.get(4)).toEqual({ id: 4, name: "4.png", dirName: "d", size: 0, mtimeMs: 0 });
  });
  it("hydrate 与 toggleItems 不把 id 记入 seen：别的目录的图不会被判缺失", () => {
    useBasket.getState().hydrate([rest(3)]);
    useBasket.getState().toggleItems([{ id: 8, name: "8.png", dirName: "o", size: 1, mtimeMs: 1 }]);
    load([1]);
    load([1, 2], "/r", 1);
    expect(useBasket.getState().missing.size).toBe(0);
  });
});
