import { describe, expect, it } from "vitest";
import { PIXEL_BUDGET, preloadPlan } from "./preloadPlan";

describe("preloadPlan", () => {
  it("顺序为 当前、下一张、上一张、下下张、上上张", () => {
    expect(preloadPlan([1, 2, 3, 4, 5], 2, () => 1e6)).toEqual([3, 4, 2, 5, 1]);
  });

  it("列表两端越界的位置跳过", () => {
    expect(preloadPlan([1, 2, 3, 4, 5], 0, () => 1e6)).toEqual([1, 2, 3]);
    expect(preloadPlan([1, 2, 3, 4, 5], 4, () => 1e6)).toEqual([5, 4, 3]);
    expect(preloadPlan([7], 0, () => 1e6)).toEqual([7]);
    expect(preloadPlan([1, 2], 5, () => 1e6)).toEqual([]);
  });

  it("超出像素预算后停止，但当前图总是保留", () => {
    // 每张 1 亿像素、预算 1.5 亿 → 只有当前图
    expect(preloadPlan([1, 2, 3, 4, 5], 2, () => 1e8, 1.5e8)).toEqual([3]);
    // 当前图本身超出预算也保留
    expect(preloadPlan([1, 2, 3], 1, (id) => (id === 2 ? 3e8 : 1), 1.5e8)).toEqual([2]);
    // 超出即停止：后面即使放得下也不要
    const px = (id: number) => ({ 1: 1, 2: 4e7, 3: 5e7, 4: 1.1e8, 5: 1 })[id] ?? 0;
    expect(preloadPlan([1, 2, 3, 4, 5], 2, px, 1.5e8)).toEqual([3]);
    // 恰好等于预算不算超出
    expect(preloadPlan([1, 2, 3], 1, () => 7.5e7, 1.5e8)).toEqual([2, 3]);
    expect(PIXEL_BUDGET).toBe(150_000_000);
  });

  it("尺寸未知按 1600 万像素估算", () => {
    // 当前 1600 万 + 4 × 3200 万 = 1.44 亿，刚好放下
    expect(preloadPlan([1, 2, 3, 4, 5], 2, (id) => (id === 3 ? null : 3.2e7))).toEqual([3, 4, 2, 5, 1]);
    // 全部未知：1600 万 × 5 = 8000 万
    expect(preloadPlan([1, 2, 3, 4, 5], 2, () => null)).toEqual([3, 4, 2, 5, 1]);
    // 预算 4000 万：当前 + 1 张（3200 万），第 3 张超出
    expect(preloadPlan([1, 2, 3, 4, 5], 2, () => null, 4e7)).toEqual([3, 4]);
  });
});
