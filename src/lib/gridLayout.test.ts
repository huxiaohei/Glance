import { describe, expect, it } from "vitest";
import type { ImageList } from "./deriveList";
import { GAP, idsInRect, layoutGrid, moveInLayout, rowIndexOf, visibleIds, wantedIds } from "./gridLayout";

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

describe("moveInLayout / rowIndexOf", () => {
  // 分组 A 有 5 张（3 列 → 行 [1,2,3] [4,5]），分组 B 有 2 张（行 [6,7]）
  const nav: ImageList = {
    ids: [1, 2, 3, 4, 5, 6, 7],
    groups: [
      { dir: "A", start: 0, count: 5, total: 5 },
      { dir: "B", start: 5, count: 2, total: 2 },
    ],
  };
  const lay = layoutGrid(nav, 3 * 100 + 2 * GAP, 100);

  it("right 跨分组：5 → 6", () => {
    expect(moveInLayout(lay, nav, 5, "right")).toBe(6);
  });
  it("down 落到下一行同一列：2 → 5；3 → 5（行不够长时落到行末）", () => {
    expect(moveInLayout(lay, nav, 2, "down")).toBe(5);
    expect(moveInLayout(lay, nav, 3, "down")).toBe(5);
  });
  it("down 跨过分组标题：4 → 6，5 → 7", () => {
    expect(moveInLayout(lay, nav, 4, "down")).toBe(6);
    expect(moveInLayout(lay, nav, 5, "down")).toBe(7);
  });
  it("up 从 6 → 4", () => {
    expect(moveInLayout(lay, nav, 6, "up")).toBe(4);
  });
  it("到头时返回原 id：left(1) = 1，down(7) = 7", () => {
    expect(moveInLayout(lay, nav, 1, "left")).toBe(1);
    expect(moveInLayout(lay, nav, 7, "down")).toBe(7);
    expect(moveInLayout(lay, nav, 1, "up")).toBe(1);
    expect(moveInLayout(lay, nav, 7, "right")).toBe(7);
  });
  it("home / end", () => {
    expect(moveInLayout(lay, nav, 4, "home")).toBe(1);
    expect(moveInLayout(lay, nav, 4, "end")).toBe(7);
  });
  it("id 不在布局里返回 null", () => {
    expect(moveInLayout(lay, nav, 99, "right")).toBeNull();
    expect(rowIndexOf(lay, 99)).toBe(-1);
    expect(rowIndexOf(lay, 4)).toBe(2);
  });
});

describe("idsInRect", () => {
  // 内容区宽 496、cell 160 → 3 列；格子 x：[0,160] [168,328] [336,496]
  // 分组 A 5 张：标题 [0,32)，行 [1,2,3] y∈[32,216]，行 [4,5] y∈[224,408]；
  // 分组 B 2 张：标题 [416,448)，行 [6,7] y∈[448,632]
  const two: ImageList = {
    ids: [1, 2, 3, 4, 5, 6, 7],
    groups: [
      { dir: "A", start: 0, count: 5, total: 5 },
      { dir: "B", start: 5, count: 2, total: 2 },
    ],
  };
  const lay = layoutGrid(two, 496, 160);

  it("矩形只碰到第一个格子时只选它", () => {
    expect(idsInRect(lay, 160, { x0: 10, y0: 40, x1: 20, y1: 50 })).toEqual([1]);
    // 文件名标签区域也算格子
    expect(idsInRect(lay, 160, { x0: 10, y0: 200, x1: 20, y1: 210 })).toEqual([1]);
  });

  it("矩形落在两个格子之间的间隙里时为空", () => {
    expect(idsInRect(lay, 160, { x0: 162, y0: 40, x1: 166, y1: 200 })).toEqual([]);
    expect(idsInRect(lay, 160, { x0: 10, y0: 218, x1: 400, y1: 222 })).toEqual([]);
  });

  it("反向拖出的矩形（x1 < x0）结果相同", () => {
    const fwd = idsInRect(lay, 160, { x0: 10, y0: 40, x1: 200, y1: 300 });
    expect(fwd).toEqual([1, 2, 4, 5]);
    expect(idsInRect(lay, 160, { x0: 200, y0: 300, x1: 10, y1: 40 })).toEqual(fwd);
    expect(idsInRect(lay, 160, { x0: 200, y0: 40, x1: 10, y1: 300 })).toEqual(fwd);
  });

  it("跨分组的矩形选中两组里相交的格子，不含标题", () => {
    expect(idsInRect(lay, 160, { x0: 10, y0: 300, x1: 200, y1: 460 })).toEqual([4, 5, 6, 7]);
    expect(idsInRect(lay, 160, { x0: 0, y0: 420, x1: 496, y1: 440 })).toEqual([]);
    expect(idsInRect(lay, 160, { x0: 0, y0: 2, x1: 496, y1: 20 })).toEqual([]);
  });

  it("矩形覆盖到屏幕外的行也算在内（1 万张布局里从顶拖到底 → 全部）", () => {
    const n = 10_000;
    const big: ImageList = {
      ids: Array.from({ length: n }, (_, i) => i),
      groups: [
        { dir: "a", start: 0, count: n / 2, total: n / 2 },
        { dir: "b", start: n / 2, count: n / 2, total: n / 2 },
      ],
    };
    const l = layoutGrid(big, 900, 160);
    expect(idsInRect(l, 160, { x0: 0, y0: 0, x1: 900, y1: l.totalHeight })).toEqual(big.ids);
    // 中段的小矩形只取那一行的前两格
    const row = l.rows.find((r) => r.kind === "images" && r.top > l.totalHeight / 2)!;
    expect(row.kind).toBe("images");
    if (row.kind === "images") {
      expect(idsInRect(l, 160, { x0: 100, y0: row.top + 10, x1: 200, y1: row.top + 20 })).toEqual(row.ids.slice(0, 2));
    }
  });
});
