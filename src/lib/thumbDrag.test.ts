import { describe, expect, it } from "vitest";
import { dragIds } from "./thumbDrag";

describe("dragIds", () => {
  it("按下的图在选中里：返回选中且在列表里的，按列表顺序", () => {
    expect(dragIds(new Set([5, 2, 9]), [1, 2, 5, 7], 5)).toEqual([2, 5]);
  });

  it("按下的图不在选中里：只返回它", () => {
    expect(dragIds(new Set([5, 2, 9]), [1, 2, 5, 7], 7)).toEqual([7]);
    expect(dragIds(new Set(), [1, 2], 1)).toEqual([1]);
  });
});
