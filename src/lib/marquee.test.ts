import { describe, expect, it } from "vitest";
import { edgeScroll } from "./marquee";

describe("edgeScroll", () => {
  it("edgeScroll：在边缘内为负或正，中间为 0", () => {
    // 滚动区 y ∈ [100, 500]，边缘带 24 px
    expect(edgeScroll(100, 100, 500)).toBe(-16);
    expect(edgeScroll(112, 100, 500)).toBe(-8);
    expect(edgeScroll(124, 100, 500)).toBe(0);
    expect(edgeScroll(300, 100, 500)).toBe(0);
    expect(edgeScroll(476, 100, 500)).toBe(0);
    expect(edgeScroll(488, 100, 500)).toBe(8);
    expect(edgeScroll(500, 100, 500)).toBe(16);
    // 指针出了滚动区：保持最大速度
    expect(edgeScroll(40, 100, 500)).toBe(-16);
    expect(edgeScroll(900, 100, 500)).toBe(16);
  });
});
