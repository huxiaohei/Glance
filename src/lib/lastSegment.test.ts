import { describe, expect, it } from "vitest";
import { lastSegment } from "./lastSegment";

describe("lastSegment", () => {
  it("取最后一级名字，两种分隔符都认", () => {
    expect(lastSegment("/Users/me/图片")).toBe("图片");
    expect(lastSegment("C:\\Users\\me\\Pictures")).toBe("Pictures");
    expect(lastSegment("C:\\Users/me\\mixed/last")).toBe("last");
  });

  it("忽略结尾的分隔符", () => {
    expect(lastSegment("/Users/me/图片/")).toBe("图片");
    expect(lastSegment("D:\\photos\\\\")).toBe("photos");
  });

  it("没有可取的一级时原样返回", () => {
    expect(lastSegment("/")).toBe("/");
    expect(lastSegment("C:\\")).toBe("C:");
    expect(lastSegment("")).toBe("");
  });
});
