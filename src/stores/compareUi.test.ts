import { beforeEach, describe, expect, it } from "vitest";
import { FIT_VIEWPORT, type CompareViewport } from "../lib/compareViewport";
import type { RootInfo } from "../ipc/types";
import { useCatalog } from "./catalog";
import { useCompareUi, viewportOf } from "./compareUi";

const ZOOMED: CompareViewport = { scale: { kind: "rel", k: 2 }, u: 0.3, v: 0.7 };

beforeEach(() => {
  useCompareUi.setState({ viewport: FIT_VIEWPORT, perCell: null, focus: null, captions: true });
  useCompareUi.setState({ panelOpen: false, panelSource: { kind: "root" }, otherDir: null });
  useCatalog.getState().reset();
});

describe("compareUi", () => {
  it("enter：视口回到适应、焦点为第一张；同步开时 perCell 为 null，关时为空 Map", () => {
    useCompareUi.setState({ viewport: ZOOMED, focus: 9 });
    useCompareUi.getState().enter(true, 3);
    let s = useCompareUi.getState();
    expect(s.viewport).toEqual(FIT_VIEWPORT);
    expect(s.perCell).toBeNull();
    expect(s.focus).toBe(3);
    useCompareUi.getState().enter(false, null);
    s = useCompareUi.getState();
    expect(s.perCell).toBeInstanceOf(Map);
    expect(s.perCell!.size).toBe(0);
    expect(s.focus).toBeNull();
  });

  it("enter 不改说明开关（说明只在本次运行内记住）", () => {
    useCompareUi.getState().toggleCaptions();
    useCompareUi.getState().enter(true, 1);
    expect(useCompareUi.getState().captions).toBe(false);
  });

  it("viewportOf：同步开时取共享视口；关时取该格自己的，没有则取共享视口", () => {
    useCompareUi.setState({ viewport: ZOOMED });
    expect(viewportOf(useCompareUi.getState(), 1)).toBe(ZOOMED);
    const own: CompareViewport = { scale: { kind: "px", s: 1 }, u: 0.5, v: 0.5 };
    useCompareUi.setState({ perCell: new Map([[1, own]]) });
    expect(viewportOf(useCompareUi.getState(), 1)).toBe(own);
    expect(viewportOf(useCompareUi.getState(), 2)).toBe(ZOOMED);
  });

  it("toggleSync：开 → 关得到空 Map（各格从共享视口出发）；关 → 开时共享视口取焦点格自己的", () => {
    useCompareUi.setState({ viewport: ZOOMED, focus: 2 });
    useCompareUi.getState().toggleSync();
    expect(useCompareUi.getState().perCell).toEqual(new Map());
    expect(useCompareUi.getState().viewport).toBe(ZOOMED);
    const own: CompareViewport = { scale: { kind: "px", s: 1 }, u: 0.1, v: 0.2 };
    useCompareUi.setState({ perCell: new Map([[2, own]]) });
    useCompareUi.getState().toggleSync();
    expect(useCompareUi.getState().perCell).toBeNull();
    expect(useCompareUi.getState().viewport).toBe(own);
  });
});

describe("compareUi 添加面板", () => {
  const root = (path: string, generation: number): RootInfo => ({ generation, path, name: path, recursive: true, focus: null });
  const open = (path: string, generation: number, relPaths: string[]) => {
    useCatalog.getState().begin(root(path, generation));
    useCatalog.getState().apply({
      type: "batch", generation, entries: relPaths.map((relPath, i) => ({ id: generation * 100 + i, relPath, size: 1, mtimeMs: 1 })),
    });
    useCatalog.getState().apply({ type: "done", generation, total: relPaths.length });
  };

  it("togglePanel 开合；默认关", () => {
    expect(useCompareUi.getState().panelOpen).toBe(false);
    useCompareUi.getState().togglePanel();
    expect(useCompareUi.getState().panelOpen).toBe(true);
    useCompareUi.getState().togglePanel();
    expect(useCompareUi.getState().panelOpen).toBe(false);
  });

  it("enter 不改面板开合与来源", () => {
    useCompareUi.getState().togglePanel();
    useCompareUi.getState().setPanelSource({ kind: "dir", dir: "a" });
    useCompareUi.getState().enter(true, 1);
    expect(useCompareUi.getState().panelOpen).toBe(true);
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "dir", dir: "a" });
  });

  it("根目录换了：子目录来源回到当前文件夹", () => {
    open("/x", 1, ["a/1.png", "b/2.png"]);
    useCompareUi.getState().setPanelSource({ kind: "dir", dir: "a" });
    open("/y", 2, ["a/1.png"]);
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "root" });
  });

  it("同一目录里所选子目录没了才回到当前文件夹；其他文件夹来源不受影响", () => {
    open("/x", 1, ["a/1.png", "b/2.png"]);
    useCompareUi.getState().setPanelSource({ kind: "dir", dir: "a" });
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [101] });
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "dir", dir: "a" });
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [100] });
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "root" });

    const other = { kind: "other" as const, name: "吴国", items: [] };
    useCompareUi.getState().setPanelSource(other);
    open("/z", 3, []);
    expect(useCompareUi.getState().panelSource).toBe(other);
  });
});
