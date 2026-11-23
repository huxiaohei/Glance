import { beforeEach, describe, expect, it } from "vitest";
import type { RootInfo } from "../ipc/types";
import { changedIds, useCatalog } from "./catalog";

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

  it("非空批次让 version 与 listVersion 都加一，且 entries 换成新引用", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    const before = useCatalog.getState();
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    const after = useCatalog.getState();
    expect(after.version).toBe(before.version + 1);
    expect(after.listVersion).toBe(before.listVersion + 1);
    expect(after.entries).not.toBe(before.entries);
  });

  it("begin 与 reset 也让 listVersion 递增", () => {
    const v0 = useCatalog.getState().listVersion;
    useCatalog.getState().begin(root(1));
    expect(useCatalog.getState().listVersion).toBe(v0 + 1);
    useCatalog.getState().reset();
    expect(useCatalog.getState().listVersion).toBe(v0 + 2);
  });

  it("dims 命中时 version 加一但 listVersion 不变", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    const before = useCatalog.getState();
    s.apply({ type: "dims", generation: 1, items: [{ id: 1, w: 4, h: 2 }] });
    const after = useCatalog.getState();
    expect(after.version).toBe(before.version + 1);
    expect(after.listVersion).toBe(before.listVersion);
    expect(after.entries.get(1)).toMatchObject({ width: 4, height: 2 });
  });

  it("空批次、没有命中的 dims 不改任何东西", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    const before = useCatalog.getState();
    s.apply({ type: "batch", generation: 1, entries: [] });
    s.apply({ type: "dims", generation: 1, items: [{ id: 99, w: 1, h: 1 }] });
    const after = useCatalog.getState();
    expect(after.entries).toBe(before.entries);
    expect(after.version).toBe(before.version);
    expect(after.listVersion).toBe(before.listVersion);
  });

  it("丢弃过期代号的 dims", () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    s.begin(root(2));
    s.apply({ type: "dims", generation: 1, items: [{ id: 1, w: 4, h: 2 }] });
    expect(useCatalog.getState().entries.size).toBe(0);
  });

  const seed = () => {
    const s = useCatalog.getState();
    s.begin(root(1));
    s.apply({ type: "batch", generation: 1, entries: [
      { id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 },
      { id: 2, relPath: "y.png", size: 2, mtimeMs: 2 },
    ] });
    s.apply({ type: "dims", generation: 1, items: [{ id: 1, w: 10, h: 20 }] });
    s.apply({ type: "done", generation: 1, total: 2 });
  };

  it("removed 删除条目并让列表版本加一", () => {
    seed();
    const before = useCatalog.getState();
    before.apply({ type: "removed", generation: 1, ids: [2, 99] });
    const after = useCatalog.getState();
    expect([...after.entries.keys()]).toEqual([1]);
    expect(after.version).toBe(before.version + 1);
    expect(after.listVersion).toBe(before.listVersion + 1);
  });

  it("removed 里全是未知 id 时状态对象不变", () => {
    seed();
    const before = useCatalog.getState();
    before.apply({ type: "removed", generation: 1, ids: [98, 99] });
    expect(useCatalog.getState()).toBe(before);
  });

  it("renamed 更新 relPath、dir、name，保留尺寸", () => {
    seed();
    const before = useCatalog.getState();
    before.apply({ type: "renamed", generation: 1, items: [{ id: 1, relPath: "b/y.png" }, { id: 99, relPath: "z.png" }] });
    const after = useCatalog.getState();
    expect(after.entries.get(1)).toMatchObject({ relPath: "b/y.png", dir: "b", name: "y.png", width: 10, height: 20 });
    expect(after.entries.has(99)).toBe(false);
    expect(after.listVersion).toBe(before.listVersion + 1);
  });

  it("renamed 里全是未知 id 时状态对象不变", () => {
    seed();
    const before = useCatalog.getState();
    before.apply({ type: "renamed", generation: 1, items: [{ id: 99, relPath: "z.png" }] });
    expect(useCatalog.getState()).toBe(before);
  });

  it("batch 重发未变化的条目时保留已补齐的尺寸", () => {
    seed();
    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 }] });
    expect(useCatalog.getState().entries.get(1)).toMatchObject({ width: 10, height: 20 });
  });

  it("batch 带来新的大小或修改时间时丢弃旧尺寸", () => {
    seed();
    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a/x.png", size: 5, mtimeMs: 1 }] });
    expect(useCatalog.getState().entries.get(1)?.width).toBeUndefined();
    expect(useCatalog.getState().entries.get(1)?.size).toBe(5);
  });

  it("batch 按 id 覆盖，不产生重复条目", () => {
    seed();
    useCatalog.getState().apply({ type: "batch", generation: 1, entries: [{ id: 2, relPath: "y.png", size: 9, mtimeMs: 9 }] });
    expect(useCatalog.getState().entries.size).toBe(2);
  });

  it("changedIds 只返回已存在且内容变了的 id", () => {
    seed();
    const { entries } = useCatalog.getState();
    expect(changedIds(entries, [
      { id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 }, // 未变
      { id: 2, relPath: "y.png", size: 2, mtimeMs: 3 },   // 变了
      { id: 7, relPath: "n.png", size: 1, mtimeMs: 1 },   // 新增
    ])).toEqual([2]);
  });

  it("watchFailed 置位，begin 与 reset 后清除", () => {
    seed();
    useCatalog.getState().apply({ type: "watchFailed", generation: 1 });
    expect(useCatalog.getState().watchFailed).toBe(true);
    useCatalog.getState().begin(root(2));
    expect(useCatalog.getState().watchFailed).toBe(false);
    useCatalog.getState().apply({ type: "watchFailed", generation: 2 });
    useCatalog.getState().reset();
    expect(useCatalog.getState().watchFailed).toBe(false);
  });

  it("过期 generation 的 removed、renamed、watchFailed 被丢弃", () => {
    seed();
    const s = useCatalog.getState();
    s.apply({ type: "removed", generation: 0, ids: [1] });
    s.apply({ type: "renamed", generation: 0, items: [{ id: 1, relPath: "q.png" }] });
    s.apply({ type: "watchFailed", generation: 0 });
    expect(useCatalog.getState()).toBe(s);
  });

  describe("keep 模式", () => {
    it("keep 模式下条目保留到 done，done 时移除未再出现的", () => {
      seed();
      const s = useCatalog.getState();
      s.begin(root(2), { keep: true });
      expect(useCatalog.getState().entries.size).toBe(2);
      expect(useCatalog.getState().scanning).toBe(true);
      s.apply({ type: "batch", generation: 2, entries: [{ id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 }] });
      expect(useCatalog.getState().entries.size).toBe(2);
      const before = useCatalog.getState();
      s.apply({ type: "done", generation: 2, total: 1 });
      const after = useCatalog.getState();
      expect([...after.entries.keys()]).toEqual([1]);
      expect(after.scanning).toBe(false);
      expect(after.listVersion).toBe(before.listVersion + 1);
      expect(after.version).toBe(before.version + 1);
    });

    it("keep 模式下 done 时没有需要移除的条目则不动 listVersion", () => {
      seed();
      const s = useCatalog.getState();
      s.begin(root(2), { keep: true });
      s.apply({ type: "batch", generation: 2, entries: [
        { id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 },
        { id: 2, relPath: "y.png", size: 2, mtimeMs: 2 },
      ] });
      const before = useCatalog.getState();
      s.apply({ type: "done", generation: 2, total: 2 });
      expect(useCatalog.getState().listVersion).toBe(before.listVersion);
      expect(useCatalog.getState().entries.size).toBe(2);
    });

    it("keep 模式下再次出现的条目保留尺寸（内容未变时）", () => {
      seed();
      const s = useCatalog.getState();
      s.begin(root(2), { keep: true });
      s.apply({ type: "batch", generation: 2, entries: [{ id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 }] });
      expect(useCatalog.getState().entries.get(1)).toMatchObject({ width: 10, height: 20 });
    });

    it("keep 模式下全部未变的批次不产生新状态，但条目仍算已确认", () => {
      seed();
      const s = useCatalog.getState();
      s.begin(root(2), { keep: true });
      const before = useCatalog.getState();
      s.apply({ type: "batch", generation: 2, entries: [{ id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 }] });
      expect(useCatalog.getState()).toBe(before);
      s.apply({ type: "done", generation: 2, total: 1 });
      expect([...useCatalog.getState().entries.keys()]).toEqual([1]);
    });

    it("批次里有一条新的或变了的（含改名）就整体更新", () => {
      seed();
      const s = useCatalog.getState();
      const before = useCatalog.getState();
      s.apply({ type: "batch", generation: 1, entries: [
        { id: 1, relPath: "a/x.png", size: 1, mtimeMs: 1 },
        { id: 2, relPath: "moved/y.png", size: 2, mtimeMs: 2 },
      ] });
      const after = useCatalog.getState();
      expect(after.listVersion).toBe(before.listVersion + 1);
      expect(after.entries.get(2)?.dir).toBe("moved");
    });

    it("不带 keep 的 begin 清空条目，done 不再移除任何东西", () => {
      seed();
      const s = useCatalog.getState();
      s.begin(root(2));
      expect(useCatalog.getState().entries.size).toBe(0);
    });
  });
});
