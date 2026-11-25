import { describe, expect, it } from "vitest";
import { fromBasketEntry, fromImageEntry, majoritySize, toggleMany } from "./basket";

describe("toggleMany", () => {
  it("有不在篮里的就追加", () => {
    const r = toggleMany([1, 2], [2, 3]);
    expect(r.order).toEqual([1, 2, 3]);
    expect(r.added).toEqual([3]);
    expect(r.removed).toEqual([]);
  });
  it("全在则全部移出", () => {
    const r = toggleMany([1, 2, 3], [3, 1]);
    expect(r.order).toEqual([2]);
    expect(r.removed).toEqual([3, 1]);
    expect(r.added).toEqual([]);
  });
  it("空目标不变", () => {
    expect(toggleMany([], [])).toEqual({ order: [], added: [], removed: [] });
  });
});

describe("majoritySize", () => {
  const s = (w: number, h: number) => ({ width: w, height: h });
  it("取出现最多的", () => {
    expect(majoritySize([s(1024, 1536), s(1024, 1536), s(1024, 1536), s(832, 1216)])).toEqual({ w: 1024, h: 1536 });
  });
  it("并列返回 null", () => {
    expect(majoritySize([s(1, 1), s(1, 1), s(2, 2), s(2, 2)])).toBeNull();
  });
  it("全无尺寸返回 null", () => {
    expect(majoritySize([{}, {}])).toBeNull();
  });
});

describe("转换", () => {
  it("fromBasketEntry 把 null 尺寸变 undefined", () => {
    const it = fromBasketEntry({ id: 1, name: "a.png", dirName: "d", size: 2, mtimeMs: 3, w: null, h: null });
    expect(it.width).toBeUndefined();
    expect(it.height).toBeUndefined();
  });
  it("fromImageEntry", () => {
    const it = fromImageEntry({ id: 1, relPath: "d/a.png", dir: "d", name: "a.png", size: 2, mtimeMs: 3, width: 4, height: 5 }, "d");
    expect(it).toEqual({ id: 1, name: "a.png", dirName: "d", size: 2, mtimeMs: 3, width: 4, height: 5 });
  });
});
