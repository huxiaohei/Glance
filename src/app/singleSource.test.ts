import { beforeEach, describe, expect, it } from "vitest";
import { useBasket } from "../stores/basket";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";
import { useNav } from "../stores/nav";
import { getSingleEntry, getSingleList, singleSource } from "./singleSource";
import { getImageList } from "./useImageList";

function openDir(path: string, files: { id: number; relPath: string; w?: number; h?: number }[]) {
  const generation = (useCatalog.getState().root?.generation ?? 0) + 1;
  useCatalog.getState().begin({ generation, path, name: path.slice(1), recursive: true, focus: null });
  useCatalog.getState().apply({
    type: "batch",
    generation,
    entries: files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.id * 10, mtimeMs: f.id })),
  });
  const dims = files.filter((f) => f.w !== undefined).map((f) => ({ id: f.id, w: f.w!, h: f.h! }));
  if (dims.length > 0) useCatalog.getState().apply({ type: "dims", generation, items: dims });
  useCatalog.getState().apply({ type: "done", generation, total: files.length });
}

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  useBasket.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name" });
});

describe("singleSource", () => {
  it("栈顶不是 single 时为 null；否则为栈顶的来源", () => {
    expect(singleSource()).toBeNull();
    useNav.getState().openSingle(1);
    expect(singleSource()).toBe("folder");
    useNav.getState().back();
    useNav.getState().openCompare();
    expect(singleSource()).toBeNull();
    useNav.getState().openSingle(1, "basket");
    expect(singleSource()).toBe("basket");
  });

  it("folder 来源：列表与条目来自当前目录", () => {
    openDir("/a", [{ id: 1, relPath: "b.jpg" }, { id: 2, relPath: "a.jpg" }]);
    useNav.getState().openSingle(1);
    expect(getSingleList()).toBe(getImageList());
    expect(getSingleEntry(1)).toBe(useCatalog.getState().entries.get(1));
  });

  it("basket 来源：列表是篮内未缺失的顺序，只有一个分组", () => {
    openDir("/a", [
      { id: 1, relPath: "a.jpg" }, { id: 2, relPath: "b.jpg" }, { id: 3, relPath: "c.jpg" }, { id: 4, relPath: "d.jpg" },
    ]);
    useBasket.getState().toggle([3, 1, 4]);
    useBasket.setState({ missing: new Set([1]) });
    useNav.getState().openCompare();
    useNav.getState().openSingle(3, "basket");
    const list = getSingleList();
    expect(list.ids).toEqual([3, 4]);
    expect(list.groups).toEqual([{ dir: "", start: 0, count: 2, total: 2 }]);
    // 篮子没变时返回同一个对象
    expect(getSingleList()).toBe(list);
  });

  it("basket 来源：不在当前目录的篮内图返回快照的名称与尺寸", () => {
    openDir("/a", [{ id: 1, relPath: "sub/x.jpg", w: 300, h: 200 }, { id: 2, relPath: "y.jpg" }]);
    useBasket.getState().toggle([1]);
    openDir("/b", [{ id: 9, relPath: "z.jpg" }]);
    useNav.getState().openCompare();
    useNav.getState().openSingle(1, "basket");
    const e = getSingleEntry(1);
    expect(e).toMatchObject({ id: 1, name: "x.jpg", relPath: "x.jpg", dir: "", size: 10, mtimeMs: 1, width: 300, height: 200 });
    // 同一快照返回同一个对象
    expect(getSingleEntry(1)).toBe(e);
    // 在当前目录里的直接用 catalog 条目
    useBasket.getState().toggle([9]);
    expect(getSingleEntry(9)).toBe(useCatalog.getState().entries.get(9));
  });
});
