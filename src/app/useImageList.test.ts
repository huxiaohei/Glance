import { beforeEach, describe, expect, it } from "vitest";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";
import { getImageList } from "./useImageList";

const w = (id: number) => ({ id, relPath: `${id}.png`, size: 1, mtimeMs: 1 });

beforeEach(() => {
  useCatalog.getState().reset();
  useListView.setState({ sort: "name", includeSubdirs: true, dirFilter: null, collapsed: new Set() });
});

describe("getImageList", () => {
  it("输入不变时返回同一个对象；条目集合或排序变化后重新派生", () => {
    useCatalog.getState().begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [w(2), w(1)] });
    const a = getImageList();
    expect(a.ids).toEqual([1, 2]);
    expect(getImageList()).toBe(a);
    // 尺寸补全不改变 listVersion：仍是同一个对象
    useCatalog.getState().apply({ type: "dims", generation: 1, items: [{ id: 1, w: 10, h: 10 }] });
    expect(getImageList()).toBe(a);

    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [w(3)] });
    const b = getImageList();
    expect(b).not.toBe(a);
    expect(b.ids).toEqual([1, 2, 3]);

    useListView.getState().setSort("size");
    expect(getImageList()).not.toBe(b);
  });
});
