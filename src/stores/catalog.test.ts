import { beforeEach, describe, expect, it } from "vitest";
import type { RootInfo } from "../ipc/types";
import { useCatalog } from "./catalog";

const root = (generation: number): RootInfo => ({ generation, path: "/r", name: "r", recursive: true, focus: null });
beforeEach(() => useCatalog.getState().reset());

describe("catalog store", () => {
  it("累积批次、补尺寸、结束扫描", () => {
    const s = useCatalog.getState();
    s.begin(root(2));
    expect(useCatalog.getState().scanning).toBe(true);
    s.apply({ type: "batch", generation: 2, entries: [{ id: 1, relPath: "a.png", size: 3, mtimeMs: 9 }] });
    s.apply({ type: "batch", generation: 2, entries: [{ id: 2, relPath: "子/b.png", size: 4, mtimeMs: 8 }] });
    s.apply({ type: "done", generation: 2, total: 2 });
    s.apply({ type: "dims", generation: 2, items: [{ id: 2, w: 30, h: 50 }, { id: 99, w: 1, h: 1 }] });
    const st = useCatalog.getState();
    expect(st.scanning).toBe(false);
    expect([...st.entries.keys()]).toEqual([1, 2]);
    expect(st.entries.get(2)).toMatchObject({ dir: "子", name: "b.png", width: 30, height: 50 });
    expect(st.entries.get(1)?.width).toBeUndefined();
  });

  it("丢弃过期代号的事件", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    s.begin(root(2));
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "old.png", size: 1, mtimeMs: 1 }] });
    s.apply({ type: "done", generation: 1, total: 1 });
    expect(useCatalog.getState().entries.size).toBe(0);
    expect(useCatalog.getState().scanning).toBe(true);
  });

  it("root 为空时丢弃所有事件", () => {
    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    expect(useCatalog.getState().entries.size).toBe(0);
  });

  it("每次变化 version 递增，且 entries 换成新引用", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    const before = useCatalog.getState();
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    const after = useCatalog.getState();
    expect(after.version).toBe(before.version + 1);
    expect(after.entries).not.toBe(before.entries);
  });
});
