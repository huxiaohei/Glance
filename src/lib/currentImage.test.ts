import { describe, expect, it } from "vitest";
import { neighbor, resolveCurrent } from "./currentImage";

describe("resolveCurrent", () => {
  it("id 仍在列表里时不变", () => {
    expect(resolveCurrent([1, 2, 3], [3, 2, 1, 4], 2)).toBe(2);
  });
  it("被删除后落到原位置上的下一张", () => {
    expect(resolveCurrent([1, 2, 3, 4], [1, 2, 4], 3)).toBe(4);
  });
  it("删的是最后一张时落到新的最后一张", () => {
    expect(resolveCurrent([1, 2, 3], [1, 2], 3)).toBe(2);
  });
  it("列表空了返回 null", () => {
    expect(resolveCurrent([1], [], 1)).toBeNull();
  });
});

describe("neighbor", () => {
  it("neighbor 到头返回 null", () => {
    expect(neighbor([1, 2, 3], 2, 1)).toBe(3);
    expect(neighbor([1, 2, 3], 2, -1)).toBe(1);
    expect(neighbor([1, 2, 3], 3, 1)).toBeNull();
    expect(neighbor([1, 2, 3], 1, -1)).toBeNull();
    expect(neighbor([1, 2, 3], 9, 1)).toBeNull();
  });
});
