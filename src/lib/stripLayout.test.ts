import { describe, expect, it } from "vitest";
import type { ImageList } from "./deriveList";
import { layoutStrip, scrollToShow, STRIP_DIVIDER, STRIP_GAP, STRIP_ITEM, stripVisible } from "./stripLayout";

// 分组 A 3 张、分组 B 2 张
const list: ImageList = {
  ids: [1, 2, 3, 4, 5],
  groups: [
    { dir: "a", start: 0, count: 3, total: 3 },
    { dir: "b", start: 3, count: 2, total: 2 },
  ],
};

describe("layoutStrip", () => {
  it("同组相邻项相距 60，跨组多出 9", () => {
    const { items, width } = layoutStrip(list);
    expect(STRIP_ITEM + STRIP_GAP).toBe(60);
    expect(STRIP_DIVIDER).toBe(9);
    expect(items.map((x) => x.left)).toEqual([0, 60, 120, 189, 249]);
    expect(items.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect(width).toBe(249 + 56);
  });

  it("第一个分组前没有分隔；groupStart 只在第 2 组起首项为真", () => {
    const { items } = layoutStrip(list);
    expect(items.map((x) => x.groupStart)).toEqual([false, false, false, true, false]);
  });

  it("折叠的分组（count 为 0）不产生项也不产生分隔；空列表宽度为 0", () => {
    const l: ImageList = {
      ids: [1, 2],
      groups: [
        { dir: "a", start: 0, count: 1, total: 1 },
        { dir: "b", start: 1, count: 0, total: 5 },
        { dir: "c", start: 1, count: 1, total: 1 },
      ],
    };
    expect(layoutStrip(l).items.map((x) => [x.left, x.groupStart])).toEqual([[0, false], [69, true]]);
    expect(layoutStrip({ ids: [], groups: [] })).toEqual({ items: [], width: 0 });
  });
});

describe("scrollToShow", () => {
  it("scrollToShow：已完整可见时不动，否则居中并夹在范围内", () => {
    const layout = layoutStrip(list); // width 305
    // 第 2 项 [60, 116) 在 [50, 250) 内：不动
    expect(scrollToShow(layout, 1, 50, 200)).toBe(50);
    // 第 5 项 [249, 305) 不在 [0, 200) 内：居中 249 + 28 - 100 = 177，夹到 305 - 200 = 105
    expect(scrollToShow(layout, 4, 0, 200)).toBe(105);
    // 第 3 项 [120, 176) 只露出一部分：居中 120 + 28 - 50 = 98
    expect(scrollToShow(layout, 2, 0, 100)).toBe(98);
    // 第 1 项：居中为负，夹到 0
    expect(scrollToShow(layout, 0, 100, 100)).toBe(0);
    // 内容比视口窄：恒为 0
    expect(scrollToShow(layout, 4, 0, 1000)).toBe(0);
  });
});

describe("stripVisible", () => {
  it("stripVisible 只返回范围内的 id（1 万张里取中间一段）", () => {
    const ids = Array.from({ length: 10000 }, (_, i) => i + 1);
    const layout = layoutStrip({ ids, groups: [{ dir: "", start: 0, count: 10000, total: 10000 }] });
    // 范围 [60000 - 120, 60000 + 600 + 120) = [59880, 60720)：
    // 第 i 项（0 起）占 [60i, 60i + 56)；与范围相交的 i 从 998（[59880, 59936)）到 1011（[60660, 60716)）
    const got = stripVisible(layout, 60000, 600, 120);
    expect(got[0]).toBe(999);
    expect(got[got.length - 1]).toBe(1012);
    expect(got).toEqual(Array.from({ length: 14 }, (_, k) => 999 + k));
    // 左缘之前的项右缘恰好碰到范围起点时不算
    expect(stripVisible(layout, 56, 4, 0)).toEqual([]);
    expect(stripVisible({ items: [], width: 0 }, 0, 600, 600)).toEqual([]);
  });
});
