import { describe, expect, it } from "vitest";
import { displayWidth, middleEllipsis } from "./middleEllipsis";

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("middleEllipsis", () => {
  it("够短时原样返回", () => {
    expect(middleEllipsis("a.png", 24)).toBe("a.png");
    expect(middleEllipsis("赵云.png", 24)).toBe("赵云.png");
  });
  it("长中文名：CJK 计 2 个单位，保留开头和扩展名", () => {
    const r = middleEllipsis("蜀国武将立绘第三版最终定稿赵云.png", 24);
    expect(r).toBe("蜀国武将立绘第三…云.png");
    expect(displayWidth(r)).toBeLessThanOrEqual(24);
  });
  it("中英混合名", () => {
    const r = middleEllipsis("赵云_final_version_2_最终稿.jpeg", 24);
    expect(displayWidth(r)).toBeLessThanOrEqual(24);
    expect(r.endsWith(".jpeg")).toBe(true);
    expect(r.startsWith("赵云_final")).toBe(true);
    expect(r).toContain("…");
  });
  it("emoji 按码点处理，不拆代理对", () => {
    const r = middleEllipsis("😀😀😀😀😀😀😀😀😀😀.png", 12);
    expect(r).toBe("😀😀…😀.png");
    expect(lone.test(r)).toBe(false);
    expect(displayWidth(r)).toBeLessThanOrEqual(12);
  });
  it("没有扩展名时只保留开头和结尾", () => {
    expect(middleEllipsis("abcdefghijklmnop", 9)).toBe("abcd…mnop");
  });
  it("max 很小或扩展名过长时仍不超宽", () => {
    expect(displayWidth(middleEllipsis("a.verylongextension", 8))).toBeLessThanOrEqual(8);
    expect(displayWidth(middleEllipsis("abcdef.png", 3))).toBeLessThanOrEqual(3);
  });
});
