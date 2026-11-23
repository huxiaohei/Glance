import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileId, RootInfo } from "../ipc/types";
import type { SortKey } from "../lib/deriveList";

type Note = { generation: number; count: number; first: FileId[]; last: FileId | null; sort: SortKey; includeSubdirs: boolean };
const recentsNote = vi.fn<(note: Note) => Promise<void>>();
vi.mock("../ipc/api", () => ({
  recentsNote: (n: Note) => recentsNote(n),
}));

const { flushRecents, startRecentsSync } = await import("./recentsSync");
const { useCatalog } = await import("../stores/catalog");
const { useListView } = await import("../stores/listView");
const { useNav } = await import("../stores/nav");
const { useSelection } = await import("../stores/selection");

const root = (generation: number): RootInfo => ({ generation, path: "/r", name: "r", recursive: true, focus: null });
const w = (id: number) => ({ id, relPath: `${id}.png`, size: id, mtimeMs: 1 });

/** 打开代号为 generation 的根目录，送入 n 张图（1..n）；scanDone 为真时扫描结束。 */
function open(generation: number, n: number, scanDone = true) {
  useCatalog.getState().begin(root(generation));
  useCatalog.getState().apply({ type: "batch", generation, entries: Array.from({ length: n }, (_, i) => w(i + 1)) });
  if (scanDone) useCatalog.getState().apply({ type: "done", generation, total: n });
}

let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  recentsNote.mockReset();
  recentsNote.mockResolvedValue(undefined);
  useCatalog.getState().reset();
  useNav.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ sort: "name", includeSubdirs: true, dirFilter: null, collapsed: new Set() });
  stop = startRecentsSync();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

const lastNote = () => recentsNote.mock.calls[recentsNote.mock.calls.length - 1][0];

describe("recentsSync", () => {
  it("扫描结束 1000 ms 后汇报张数、前四张、排序与包含子目录", () => {
    open(7, 5);
    vi.advanceTimersByTime(999);
    expect(recentsNote).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recentsNote).toHaveBeenCalledTimes(1);
    expect(recentsNote).toHaveBeenCalledWith({
      generation: 7, count: 5, first: [1, 2, 3, 4], last: null, sort: "name", includeSubdirs: true,
    });
  });

  it("扫描未结束时不汇报", () => {
    open(1, 5, false);
    useListView.getState().setSort("size");
    vi.advanceTimersByTime(5000);
    expect(recentsNote).not.toHaveBeenCalled();
  });

  it("1000 ms 内的多次变化只汇报一次，内容是最后的状态", () => {
    open(1, 5);
    vi.advanceTimersByTime(500);
    useListView.getState().setSort("size");
    vi.advanceTimersByTime(500);
    useListView.getState().setIncludeSubdirs(false);
    vi.advanceTimersByTime(999);
    expect(recentsNote).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recentsNote).toHaveBeenCalledTimes(1);
    expect(lastNote()).toMatchObject({ sort: "size", includeSubdirs: false, count: 5 });
  });

  it("last 取单张视图当前图；不在单张视图时取选中的键盘焦点；都没有为 null", () => {
    open(1, 5);
    useSelection.getState().set({ ids: new Set([2]), focus: 2, anchor: 2 });
    useNav.getState().openSingle(3);
    vi.advanceTimersByTime(1000);
    expect(lastNote().last).toBe(3);
    useNav.getState().back();
    vi.advanceTimersByTime(1000);
    expect(lastNote().last).toBe(2);
    useSelection.getState().clear();
    vi.advanceTimersByTime(1000);
    expect(lastNote().last).toBeNull();
    expect(recentsNote).toHaveBeenCalledTimes(3);
  });

  it("内容与上次相同就不再发", () => {
    open(1, 5);
    vi.advanceTimersByTime(1000);
    expect(recentsNote).toHaveBeenCalledTimes(1);
    useListView.getState().setSort("size");
    useListView.getState().setSort("name");
    useListView.getState().setCell(200);
    vi.advanceTimersByTime(1000);
    expect(recentsNote).toHaveBeenCalledTimes(1);
  });

  it("flushRecents 立刻发出待发的汇报；没有待发的则什么也不做", () => {
    flushRecents();
    expect(recentsNote).not.toHaveBeenCalled();
    open(1, 5);
    vi.advanceTimersByTime(300);
    flushRecents();
    expect(recentsNote).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(recentsNote).toHaveBeenCalledTimes(1);
    flushRecents();
    expect(recentsNote).toHaveBeenCalledTimes(1);
  });

  it("没有根目录时不汇报", () => {
    useListView.getState().setSort("size");
    useSelection.getState().set({ ids: new Set([2]), focus: 2, anchor: 2 });
    vi.advanceTimersByTime(2000);
    flushRecents();
    expect(recentsNote).not.toHaveBeenCalled();
  });

  it("后端拒绝时不抛错", async () => {
    recentsNote.mockRejectedValue(new Error("boom"));
    open(1, 5);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(recentsNote).toHaveBeenCalledTimes(1);
    useListView.getState().setSort("size");
    expect(() => flushRecents()).not.toThrow();
    await Promise.resolve();
    expect(recentsNote).toHaveBeenCalledTimes(2);
  });
});
