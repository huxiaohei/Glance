import { describe, expect, it } from "vitest";
import { naturalCompare } from "./naturalCompare";

const sorted = (xs: string[]) => [...xs].sort(naturalCompare);

describe("naturalCompare", () => {
  it("数字按数值排", () => {
    expect(sorted(["10.png", "2.png", "1.png"])).toEqual(["1.png", "2.png", "10.png"]);
    expect(sorted(["图 10.png", "图 2.png"])).toEqual(["图 2.png", "图 10.png"]);
  });
  it("不分大小写", () => {
    expect(sorted(["img10.png", "IMG2.PNG", "b.png", "A.png"])).toEqual(["A.png", "b.png", "IMG2.PNG", "img10.png"]);
  });
  it("相等时稳定且不返回 0", () => {
    expect(naturalCompare("a.png", "A.png")).not.toBe(0);
    expect(naturalCompare("a.png", "a.png")).toBe(0);
  });
});
