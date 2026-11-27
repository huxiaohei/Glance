import { describe, expect, it } from "vitest";
import { allCodecNames, codecKindOf } from "./codecKind";

describe("codecKindOf", () => {
  it("按扩展名认 heif 与 avif，不分大小写", () => {
    expect(codecKindOf("a.HEIC")).toBe("heif");
    expect(codecKindOf("b.heif")).toBe("heif");
    expect(codecKindOf("c.avif")).toBe("avif");
    expect(codecKindOf("c.AVIF")).toBe("avif");
  });
  it("其他扩展名与无扩展名是 null", () => {
    expect(codecKindOf("d.jpg")).toBeNull();
    expect(codecKindOf("noext")).toBeNull();
    expect(codecKindOf("heic")).toBeNull();
    expect(codecKindOf(".heic")).toBeNull();
  });
});

describe("allCodecNames", () => {
  it("全部是 heif / avif 才为真，空列表为假", () => {
    expect(allCodecNames(["a.heic", "b.avif"])).toBe(true);
    expect(allCodecNames(["a.heic", "c.jpg"])).toBe(false);
    expect(allCodecNames([])).toBe(false);
  });
});
