import { describe, expect, it } from "vitest";
import { copyModifier, dragIds, selectModifier, transferPlan } from "./thumbDrag";

describe("dragIds", () => {
  it("按下的图在选中里：返回选中且在列表里的，按列表顺序", () => {
    expect(dragIds(new Set([5, 2, 9]), [1, 2, 5, 7], 5)).toEqual([2, 5]);
  });

  it("按下的图不在选中里：只返回它", () => {
    expect(dragIds(new Set([5, 2, 9]), [1, 2, 5, 7], 7)).toEqual([7]);
    expect(dragIds(new Set(), [1, 2], 1)).toEqual([1]);
  });
});

describe("transferPlan", () => {
  const entries = new Map([
    [1, { dir: "a" }],
    [2, { dir: "" }],
    [3, { dir: "a" }],
    [4, { dir: "a/b" }],
  ]);

  it("transferPlan：移动时去掉已在目标目录里的，复制时保留", () => {
    expect(transferPlan([1, 2, 3, 4], entries, "a", false)).toEqual([2, 4]);
    expect(transferPlan([1, 2, 3, 4], entries, "a", true)).toEqual([1, 2, 3, 4]);
    expect(transferPlan([1, 2, 3], entries, "", false)).toEqual([1, 3]);
    expect(transferPlan([1, 3], entries, "a", false)).toEqual([]);
  });

  it("transferPlan：去掉已不在条目表里的 id，保持顺序", () => {
    expect(transferPlan([4, 9, 2, 1], entries, "x", false)).toEqual([4, 2, 1]);
    expect(transferPlan([9, 4, 8], entries, "x", true)).toEqual([4]);
    expect(transferPlan([9], entries, "x", true)).toEqual([]);
  });
});

describe("copyModifier", () => {
  it("copyModifier：macOS 看 altKey，其他平台看 ctrlKey", () => {
    expect(copyModifier({ altKey: true, ctrlKey: false }, true)).toBe(true);
    expect(copyModifier({ altKey: false, ctrlKey: true }, true)).toBe(false);
    expect(copyModifier({ altKey: false, ctrlKey: true }, false)).toBe(true);
    expect(copyModifier({ altKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

describe("selectModifier", () => {
  it("按着 Meta、Ctrl 或 Shift 都算（各平台相同）", () => {
    const none = { metaKey: false, ctrlKey: false, shiftKey: false };
    expect(selectModifier(none)).toBe(false);
    expect(selectModifier({ ...none, metaKey: true })).toBe(true);
    expect(selectModifier({ ...none, ctrlKey: true })).toBe(true);
    expect(selectModifier({ ...none, shiftKey: true })).toBe(true);
  });
});
