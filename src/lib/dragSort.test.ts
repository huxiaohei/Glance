import { describe, expect, it } from "vitest";
import { previewOrder, slotAt } from "./dragSort";

// 4 列，格子 100×150，间隙 10；网格左上角在 (20, 40)
const GRID = { left: 20, top: 40, cellW: 100, cellH: 150, gapX: 10, gapY: 10, columns: 4 };

describe("slotAt", () => {
  it("格子内部：所在的格", () => {
    expect(slotAt({ x: 70, y: 100 }, GRID, 10)).toBe(0);
    expect(slotAt({ x: 20 + 110 * 2 + 50, y: 100 }, GRID, 10)).toBe(2);
    expect(slotAt({ x: 20 + 110 + 50, y: 40 + 160 + 75 }, GRID, 10)).toBe(5);
  });

  it("按格子中心线：离哪格中心近算哪格（含格间隙）", () => {
    // 第 0 格右边缘 120，间隙到 130，中线 125
    expect(slotAt({ x: 119, y: 100 }, GRID, 10)).toBe(0);
    expect(slotAt({ x: 124, y: 100 }, GRID, 10)).toBe(0);
    expect(slotAt({ x: 126, y: 100 }, GRID, 10)).toBe(1);
    // 两行之间的间隙：190..200，中线 195
    expect(slotAt({ x: 70, y: 194 }, GRID, 10)).toBe(0);
    expect(slotAt({ x: 70, y: 196 }, GRID, 10)).toBe(4);
  });

  it("越界：夹到网格范围内", () => {
    expect(slotAt({ x: -500, y: -500 }, GRID, 10)).toBe(0);
    expect(slotAt({ x: 5000, y: 100 }, GRID, 10)).toBe(3);
    expect(slotAt({ x: -500, y: 40 + 160 + 75 }, GRID, 10)).toBe(4);
    expect(slotAt({ x: 5000, y: 5000 }, GRID, 10)).toBe(9);
  });

  it("最后一格之后的空槽算末尾", () => {
    // 10 张：第 3 行只有 8、9 两格，第 3 行第 4 格是空槽
    expect(slotAt({ x: 20 + 110 * 3 + 50, y: 40 + 320 + 75 }, GRID, 10)).toBe(9);
    // 再往下一整行也是末尾
    expect(slotAt({ x: 70, y: 40 + 480 + 75 }, GRID, 10)).toBe(9);
  });

  it("没有格子时为 0", () => {
    expect(slotAt({ x: 70, y: 100 }, GRID, 0)).toBe(0);
  });
});

describe("previewOrder", () => {
  const order = [1, 2, 3, 4, 5];
  it("后移", () => {
    expect(previewOrder(order, 0, 2)).toEqual([2, 3, 1, 4, 5]);
    expect(previewOrder(order, 1, 4)).toEqual([1, 3, 4, 5, 2]);
  });
  it("前移", () => {
    expect(previewOrder(order, 4, 0)).toEqual([5, 1, 2, 3, 4]);
    expect(previewOrder(order, 3, 1)).toEqual([1, 4, 2, 3, 5]);
  });
  it("原位：内容不变、返回新数组", () => {
    const r = previewOrder(order, 2, 2);
    expect(r).toEqual(order);
    expect(r).not.toBe(order);
  });
});
