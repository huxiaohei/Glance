import { describe, expect, it } from "vitest";
import type { ImageList } from "./deriveList";
import { layoutGrid, visibleIds, wantedIds } from "./gridLayout";

const list: ImageList = {
  ids: [1, 2, 3, 4, 5, 6, 7],
  groups: [
    { dir: "", start: 0, count: 5, total: 5 },
    { dir: "折叠", start: 5, count: 0, total: 9 },
    { dir: "蜀国", start: 5, count: 2, total: 2 },
  ],
};

describe("layoutGrid", () => {
  it("格子大小变化时列数和行位置都随之变化", () => {
    const big: ImageList = {
      ids: Array.from({ length: 40 }, (_, i) => i),
      groups: [{ dir: "", start: 0, count: 20, total: 20 }, { dir: "a", start: 20, count: 20, total: 20 }],
    };
    const small = layoutGrid(big, 700, 160);
    const large = layoutGrid(big, 700, 320);
    expect(small.columns).not.toBe(large.columns);
    expect(small.rows.map((r) => r.top)).not.toEqual(large.rows.map((r) => r.top));
    expect(small.totalHeight).not.toBe(large.totalHeight);
  });

  it("列数由宽度和格子大小决定，至少 1 列", () => {
    expect(layoutGrid(list, 496, 160).columns).toBe(3); // 3×160 + 2×8 = 496
    expect(layoutGrid(list, 495, 160).columns).toBe(2);
    expect(layoutGrid(list, 50, 160).columns).toBe(1);
  });

  it("按组出标题行和图片行，位置连续", () => {
    expect(layoutGrid(list, 496, 160)).toEqual({
      columns: 3,
      totalHeight: 664,
      rows: [
        { kind: "header", dir: "", count: 5, total: 5, top: 0, height: 32 },
        { kind: "images", ids: [1, 2, 3], top: 32, height: 184 },
        { kind: "images", ids: [4, 5], top: 224, height: 184 },
        { kind: "header", dir: "折叠", count: 0, total: 9, top: 416, height: 32 },
        { kind: "header", dir: "蜀国", count: 2, total: 2, top: 448, height: 32 },
        { kind: "images", ids: [6, 7], top: 480, height: 184 },
      ],
    });
  });

  it("空列表高度为 0", () => {
    expect(layoutGrid({ ids: [], groups: [] }, 800, 160)).toEqual({ columns: 4, rows: [], totalHeight: 0 });
  });
});

describe("visibleIds", () => {
  it("可见范围按行求交，含 overscan", () => {
    const layout = layoutGrid(list, 496, 160);
    expect(visibleIds(layout, 0, 200, 0)).toEqual([1, 2, 3]);
    expect(visibleIds(layout, 0, 200, 100)).toEqual([1, 2, 3, 4, 5]);
    expect(visibleIds(layout, 470, 100, 0)).toEqual([6, 7]);
    expect(visibleIds(layout, 5000, 100, 0)).toEqual([]);
  });
});

describe("wantedIds", () => {
  it("先视口内，再下方 overscan（自上而下），最后上方 overscan（由近及远）", () => {
    const big: ImageList = {
      ids: Array.from({ length: 10 }, (_, i) => i + 1),
      groups: [{ dir: "", start: 0, count: 10, total: 10 }],
    };
    // 1 列、格子 160：图片行 top = 32 + 192k，高 184（行 k 含 ids[k]）
    const layout = layoutGrid(big, 160, 160);
    expect(layout.columns).toBe(1);
    // 视口 [420, 620) 与第 2、3、4 行（id 3、4）相交：行 top 416、608；overscan 各 400
    expect(wantedIds(layout, 420, 200, 400)).toEqual([3, 4, 5, 6, 2, 1]);
  });

  it("没有视口外的行时与 visibleIds 一致", () => {
    const layout = layoutGrid(list, 496, 160);
    expect(wantedIds(layout, 0, 200, 0)).toEqual([1, 2, 3]);
    expect(wantedIds(layout, 5000, 100, 0)).toEqual([]);
  });
});
