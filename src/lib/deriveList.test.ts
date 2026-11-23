import { describe, expect, it } from "vitest";
import { comparePaths, deriveList, dirTree, hasSize, toImageEntry, type ListOptions } from "./deriveList";

const e = (id: number, relPath: string, size = 1, mtimeMs = 0) => toImageEntry({ id, relPath, size, mtimeMs });
const base: ListOptions = { sort: "name", includeSubdirs: true, dirFilter: null, collapsed: new Set() };
const sample = [
  e(1, "b.png"), e(2, "a.png"),
  e(3, "魏国/曹操.png"), e(4, "蜀国/赵云 10.png"), e(5, "蜀国/赵云 2.png"),
  e(6, "蜀国/五虎/关羽.png"),
];

describe("deriveList", () => {
  it("拆出目录和文件名", () => {
    expect(e(6, "蜀国/五虎/关羽.png")).toMatchObject({ dir: "蜀国/五虎", name: "关羽.png" });
    expect(e(1, "b.png")).toMatchObject({ dir: "", name: "b.png" });
  });

  it("根目录在前，子目录自然排序，组内按文件名", () => {
    expect(deriveList(sample, base)).toEqual({
      ids: [2, 1, 5, 4, 6, 3],
      groups: [
        { dir: "", start: 0, count: 2, total: 2 },
        { dir: "蜀国", start: 2, count: 2, total: 2 },
        { dir: "蜀国/五虎", start: 4, count: 1, total: 1 },
        { dir: "魏国", start: 5, count: 1, total: 1 },
      ],
    });
  });

  it("关闭包含子目录只留当前层", () => {
    expect(deriveList(sample, { ...base, includeSubdirs: false })).toEqual({
      ids: [2, 1], groups: [{ dir: "", start: 0, count: 2, total: 2 }],
    });
  });

  it("目录筛选包含其下级，且不误伤同前缀的兄弟目录", () => {
    const withSibling = [...sample, e(7, "蜀国备选/x.png")];
    expect(deriveList(withSibling, { ...base, dirFilter: "蜀国" }).ids).toEqual([5, 4, 6]);
    expect(deriveList(withSibling, { ...base, dirFilter: "蜀国", includeSubdirs: false }).ids).toEqual([5, 4]);
  });

  it("折叠的组保留标题但不出图", () => {
    expect(deriveList(sample, { ...base, collapsed: new Set(["蜀国"]) })).toEqual({
      ids: [2, 1, 6, 3],
      groups: [
        { dir: "", start: 0, count: 2, total: 2 },
        { dir: "蜀国", start: 2, count: 0, total: 2 },
        { dir: "蜀国/五虎", start: 2, count: 1, total: 1 },
        { dir: "魏国", start: 3, count: 1, total: 1 },
      ],
    });
  });

  it("按时间和大小排序，新的、大的在前，相等时按文件名", () => {
    const xs = [e(1, "a.png", 5, 100), e(2, "b.png", 9, 300), e(3, "c.png", 9, 200), e(4, "d.png", 1, 300)];
    expect(deriveList(xs, { ...base, sort: "mtime" }).ids).toEqual([2, 4, 3, 1]);
    expect(deriveList(xs, { ...base, sort: "size" }).ids).toEqual([2, 3, 1, 4]);
  });

  it("没有图片时返回空列表而不是报错", () => {
    expect(deriveList([], base)).toEqual({ ids: [], groups: [] });
    expect(deriveList([e(1, "子/a.png")], { ...base, includeSubdirs: false })).toEqual({ ids: [], groups: [] });
  });
});

describe("dirTree", () => {
  it("目录树含中间目录，count 为直属，total 含下级", () => {
    expect(dirTree([...sample, e(8, "甲组/水军/子/周瑜.png")])).toEqual([
      { dir: "甲组", name: "甲组", depth: 0, count: 0, total: 1 },
      { dir: "甲组/水军", name: "水军", depth: 1, count: 0, total: 1 },
      { dir: "甲组/水军/子", name: "子", depth: 2, count: 1, total: 1 },
      { dir: "蜀国", name: "蜀国", depth: 0, count: 2, total: 3 },
      { dir: "蜀国/五虎", name: "五虎", depth: 1, count: 1, total: 1 },
      { dir: "魏国", name: "魏国", depth: 0, count: 1, total: 1 },
    ]);
  });
});

describe("comparePaths", () => {
  it("逐段比较：父目录在前、子目录紧随，根最先", () => {
    expect(["蜀国/五虎", "蜀国 2", "蜀国", ""].sort(comparePaths)).toEqual(["", "蜀国", "蜀国/五虎", "蜀国 2"]);
  });

  it("deriveList 的分组顺序与之一致", () => {
    const list = deriveList(
      [e(1, "蜀国 2/a.png"), e(2, "蜀国/五虎/b.png"), e(3, "蜀国/c.png"), e(4, "d.png")],
      base,
    );
    expect(list.groups.map((g) => g.dir)).toEqual(["", "蜀国", "蜀国/五虎", "蜀国 2"]);
    expect(dirTree([e(1, "蜀国 2/a.png"), e(2, "蜀国/五虎/b.png")]).map((n) => n.dir))
      .toEqual(["蜀国", "蜀国/五虎", "蜀国 2"]);
  });
});

describe("hasSize", () => {
  it("宽高都已知且为正才算有尺寸", () => {
    expect(hasSize(e(1, "a.png"))).toBe(false);
    expect(hasSize({ ...e(1, "a.png"), width: 0, height: 10 })).toBe(false);
    expect(hasSize({ ...e(1, "a.png"), width: 10, height: 0 })).toBe(false);
    expect(hasSize({ ...e(1, "a.png"), width: 10, height: 5 })).toBe(true);
  });
});
