import { describe, expect, it } from "vitest";
import type { BasketItem } from "./basket";
import { dirTree, type ImageEntry } from "./deriveList";
import { panelIds, panelOptions } from "./panelSource";

const e = (id: number, relPath: string, size = 1, mtimeMs = 1): ImageEntry => {
  const i = relPath.lastIndexOf("/");
  return { id, relPath, dir: i < 0 ? "" : relPath.slice(0, i), name: relPath.slice(i + 1), size, mtimeMs };
};
const ENTRIES = [e(1, "b.png"), e(2, "a.png"), e(3, "魏国/曹操.png"), e(4, "魏国/将/张辽.png"), e(5, "蜀国/关羽.png")];
const map = new Map(ENTRIES.map((x) => [x.id, x]));

describe("panelOptions", () => {
  it("根、各子目录（带层级与张数）、最近的其他文件夹", () => {
    const opts = panelOptions(dirTree(ENTRIES), 5, { name: "吴国", count: 7 });
    expect(opts.map(({ key, depth, count }) => ({ key, depth, count }))).toEqual([
      { key: "root", depth: 0, count: 5 },
      { key: "dir:蜀国", depth: 1, count: 1 },
      { key: "dir:魏国", depth: 1, count: 2 },
      { key: "dir:魏国/将", depth: 2, count: 1 },
      { key: "other", depth: 0, count: 7 },
    ]);
    expect(opts.map((o) => o.label)).toEqual(["", "蜀国", "魏国", "将", "吴国"]);
  });

  it("没有其他文件夹时不列它", () => {
    expect(panelOptions([], 2, null).map((o) => o.key)).toEqual(["root"]);
  });
});

describe("panelIds", () => {
  it("root 照搬网格的排序与包含子目录", () => {
    expect(panelIds(map, "name", true, { kind: "root" })).toEqual([2, 1, 5, 3, 4]);
    expect(panelIds(map, "name", false, { kind: "root" })).toEqual([2, 1]);
  });

  it("dir 包含子目录（includeSubdirs）或只有本层", () => {
    expect(panelIds(map, "name", true, { kind: "dir", dir: "魏国" })).toEqual([3, 4]);
    expect(panelIds(map, "name", false, { kind: "dir", dir: "魏国" })).toEqual([3]);
  });

  it("other 按文件名自然序", () => {
    const it_ = (id: number, name: string): BasketItem => ({ id, name, dirName: "吴国", size: 1, mtimeMs: 1 });
    const items = [it_(10, "img10.png"), it_(11, "img2.png"), it_(12, "img1.png")];
    expect(panelIds(map, "size", true, { kind: "other", name: "吴国", items })).toEqual([12, 11, 10]);
  });
});
