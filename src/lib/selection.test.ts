import { describe, expect, it } from "vitest";
import type { ImageList } from "./deriveList";
import { EMPTY, moveTo, prune, selectAll, selectGroup, selectMany, selectOnly, selectRange, toggle, type Selection } from "./selection";

const list: ImageList = {
  ids: [1, 2, 3, 4, 5, 6, 7],
  groups: [
    { dir: "A", start: 0, count: 5, total: 5 },
    { dir: "B", start: 5, count: 2, total: 2 },
  ],
};
const sel = (ids: number[], focus: number | null, anchor: number | null = focus): Selection => ({ ids: new Set(ids), focus, anchor });
const arr = (s: Selection) => [...s.ids].sort((a, b) => a - b);

describe("selection", () => {
  it("selectOnly", () => {
    expect(selectOnly(3)).toEqual(sel([3], 3));
  });
  it("toggle 两次回到未选中，但焦点留在它上面", () => {
    const a = toggle(EMPTY, 3);
    expect(arr(a)).toEqual([3]);
    const b = toggle(a, 3);
    expect(arr(b)).toEqual([]);
    expect(b.focus).toBe(3);
    expect(b.anchor).toBe(3);
  });
  it("selectRange 反向也可：anchor 5，点 2 → {2,3,4,5}，anchor 仍为 5", () => {
    const r = selectRange(sel([5], 5), list, 2);
    expect(arr(r)).toEqual([2, 3, 4, 5]);
    expect(r.anchor).toBe(5);
    expect(r.focus).toBe(2);
  });
  it("连续 Shift 点击以同一个锚点重算范围：anchor 3，点 6 再点 1 → {1,2,3}", () => {
    const a = selectRange(sel([3], 3), list, 6);
    expect(arr(a)).toEqual([3, 4, 5, 6]);
    const b = selectRange(a, list, 1);
    expect(arr(b)).toEqual([1, 2, 3]);
    expect(b.anchor).toBe(3);
  });
  it("锚点不在列表里时 selectRange 退化为单选", () => {
    expect(selectRange(sel([99], 99), list, 2)).toEqual(sel([2], 2));
    expect(selectRange(EMPTY, list, 2)).toEqual(sel([2], 2));
  });
  it("selectRange 无变化时返回原对象", () => {
    const s = sel([3], 3);
    expect(selectRange(s, list, 3)).toBe(s);
  });
  it("moveTo", () => {
    expect(moveTo(sel([2], 2), list, 3, false)).toEqual(sel([3], 3));
    expect(arr(moveTo(sel([2], 2), list, 4, true))).toEqual([2, 3, 4]);
  });
  it("selectGroup", () => {
    const g = selectGroup(EMPTY, list, "B");
    expect(arr(g)).toEqual([6, 7]);
    expect(g.focus).toBe(6);
    expect(g.anchor).toBe(6);
    expect(selectGroup(g, list, "B")).toBe(g);
    expect(selectGroup(g, list, "nope")).toBe(g);
    const empty: ImageList = { ids: [], groups: [{ dir: "C", start: 0, count: 0, total: 3 }] };
    expect(selectGroup(EMPTY, empty, "C")).toBe(EMPTY);
  });
  it("selectAll 第一次选中焦点所在分组，第二次选中全部", () => {
    const a = selectAll(sel([6], 6), list);
    expect(arr(a)).toEqual([6, 7]);
    expect(a.focus).toBe(6);
    const b = selectAll(a, list);
    expect(arr(b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(b.focus).toBe(6);
    expect(selectAll(b, list)).toBe(b);
  });
  it("没有焦点时 selectAll 先选第一组", () => {
    const a = selectAll(EMPTY, list);
    expect(arr(a)).toEqual([1, 2, 3, 4, 5]);
    expect(a.focus).toBe(1);
    expect(a.anchor).toBe(1);
  });
  it("只有一个分组时 selectAll 一次就是全部，再按不变（返回原对象）", () => {
    const one: ImageList = { ids: [1, 2, 3], groups: [{ dir: "", start: 0, count: 3, total: 3 }] };
    const a = selectAll(EMPTY, one);
    expect(arr(a)).toEqual([1, 2, 3]);
    expect(selectAll(a, one)).toBe(a);
  });
  it("空列表 selectAll 返回原对象", () => {
    expect(selectAll(EMPTY, { ids: [], groups: [] })).toBe(EMPTY);
  });
  const alive = (...ids: number[]) => new Map(ids.map((id) => [id, true]));
  it("prune 去掉已消失的 id；锚点消失时按原顺序落到相邻的", () => {
    const p = prune(sel([1, 2, 3], 3, 1), alive(2, 3), [1, 2, 3]);
    expect(arr(p)).toEqual([2, 3]);
    expect(p.focus).toBe(3);
    expect(p.anchor).toBe(2);
  });
  it("焦点被移除后落到原顺序里的下一张；它是最后一张时落到上一张；全没了为 null", () => {
    expect(prune(sel([2], 2), alive(1, 3, 4), [1, 2, 3, 4]).focus).toBe(3);
    expect(prune(sel([2], 2), alive(1, 4), [1, 2, 3, 4]).focus).toBe(4);
    expect(prune(sel([4], 4), alive(1, 2), [1, 2, 3, 4]).focus).toBe(2);
    expect(prune(sel([1], 1), alive(), [1]).focus).toBeNull();
  });
  it("焦点移动后不自动选中", () => {
    const p = prune(sel([2], 2), alive(1, 3), [1, 2, 3]);
    expect(p.focus).toBe(3);
    expect(p.ids.size).toBe(0);
  });
  it("焦点还在时不动；prevOrder 里没有焦点时置空", () => {
    const s = sel([1, 2], 2, 1);
    expect(prune(s, alive(1, 2, 3), [3, 1, 2])).toBe(s);
    const p = prune(sel([2], 2), alive(1, 3), [1, 3]);
    expect(p.focus).toBeNull();
    expect(p.anchor).toBeNull();
  });
  it("prune 无变化时返回原对象", () => {
    const s = sel([1, 2], 2, 1);
    expect(prune(s, alive(1, 2, 3), [1, 2, 3])).toBe(s);
    expect(prune(EMPTY, alive(), [])).toBe(EMPTY);
  });
  it("selectMany 叠加时取并集", () => {
    const base = sel([1, 2], 2);
    const r = selectMany(base, [4, 5], true);
    expect(arr(r)).toEqual([1, 2, 4, 5]);
    expect(r.focus).toBe(5);
    expect(arr(selectMany(base, [4, 5], false))).toEqual([4, 5]);
    expect(selectMany(base, [], true)).toBe(base);
    expect(selectMany(base, [], false)).toEqual({ ids: new Set(), focus: 2, anchor: 2 });
  });
});
