import { describe, expect, it } from "vitest";
import { middleEllipsis } from "./middleEllipsis";

describe("middleEllipsis", () => {
  it("够短时原样返回", () => {
    expect(middleEllipsis("a.png", 12)).toBe("a.png");
    expect(middleEllipsis("123456789.png", 13)).toBe("123456789.png");
  });
  it("保留开头和扩展名，总长不超过 max", () => {
    const r = middleEllipsis("很长很长的文件名_final_v2.png", 12);
    expect(r).toBe("很长很长的…v2.png");
    expect(r.length).toBe(12);
    expect(r.endsWith(".png")).toBe(true);
  });
  it("没有扩展名时只保留开头和结尾", () => {
    expect(middleEllipsis("abcdefghijklmnop", 9)).toBe("abcd…mnop");
  });
  it("扩展名过长或 max 过小时仍不超长", () => {
    expect(middleEllipsis("a.verylongextension", 8).length).toBeLessThanOrEqual(8);
    expect(middleEllipsis("abcdef.png", 3).length).toBeLessThanOrEqual(3);
  });
});
