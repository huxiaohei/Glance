import { describe, expect, it } from "vitest";
import { isScaledDown } from "./scaledDown";

describe("isScaledDown", () => {
  it("显示的像素宽度小于条目宽度：已缩小", () => {
    expect(isScaledDown(8000, 12000)).toBe(true);
  });
  it("相等或更大：没有缩小", () => {
    expect(isScaledDown(4000, 4000)).toBe(false);
    expect(isScaledDown(4001, 4000)).toBe(false);
  });
  it("条目宽度未知，或还没有显示的图：不算缩小", () => {
    expect(isScaledDown(8000, undefined)).toBe(false);
    expect(isScaledDown(0, 12000)).toBe(false);
  });
});
