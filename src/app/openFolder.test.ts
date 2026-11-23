import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEvent, RecentEntry, RootInfo } from "../ipc/types";

const log: string[] = [];
const openPath = vi.fn<(path: string, recursive: boolean, seq: number, restore: boolean, onEvent: (e: CatalogEvent) => void) => Promise<RootInfo>>();
const recentsList = vi.fn<() => Promise<RecentEntry[]>>();
const recentsNote = vi.fn<(note: unknown) => Promise<void>>();
vi.mock("../ipc/api", () => ({
  openPath: (...a: Parameters<typeof openPath>) => (log.push(`openPath:${a[0]}`), openPath(...a)),
  recentsList: () => (log.push("recentsList"), recentsList()),
  recentsNote: (n: unknown) => (log.push("recentsNote"), recentsNote(n)),
  thumbsSubscribe: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
// flushRecents 默认走真实实现；测试可临时换成抛错或拒绝的替身
const flushImpl = vi.hoisted(() => ({ current: null as null | (() => Promise<void>) }));
vi.mock("./recentsSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("./recentsSync")>();
  return { ...real, flushRecents: () => (flushImpl.current ? flushImpl.current() : real.flushRecents()) };
});

const { openFolder, openRecent, refreshFolder } = await import("./openFolder");
const { startRecentsSync } = await import("./recentsSync");
const { useListView } = await import("../stores/listView");
const { useCatalog } = await import("../stores/catalog");
const { useThumbs } = await import("../stores/thumbs");
const { DEFAULT_SETTINGS, useSettings } = await import("../stores/settings");
const { useToast } = await import("../stores/toast");
const { t } = await import("../i18n");

const info = (generation: number, name: string): RootInfo => ({ generation, path: "/real/dir", name, recursive: true, focus: null });

beforeEach(() => {
  useCatalog.getState().reset();
  useThumbs.getState().reset();
  openPath.mockReset();
  recentsList.mockReset();
  recentsList.mockResolvedValue([]);
  recentsNote.mockReset();
  recentsNote.mockResolvedValue(undefined);
  log.length = 0;
  flushImpl.current = null;
  useListView.setState({ sort: "name" });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useToast.setState({ current: null });
});

/** openPath 成功并立刻送来“扫描结束”（事件在 begin 之后回放）。 */
function resolveScanned(generation: number, path = "/real/dir", recursive = true) {
  openPath.mockImplementationOnce(async (_p, _r, _s, _restore, onEvent) => {
    onEvent({ type: "done", generation, total: 0 });
    return { ...info(generation, "dir"), path, recursive };
  });
}

/** 让排队、flush 等微任务与零延时任务走完。 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const recent = (over: Partial<RecentEntry> = {}): RecentEntry => ({
  path: "/photos", name: "photos", count: 3, thumbs: [], pinned: false, exists: true, sort: null, includeSubdirs: null, ...over,
});

describe("openRecent", () => {
  it("openRecent 带 restore 打开，并按该项的 includeSubdirs 与 sort 恢复", async () => {
    openPath.mockResolvedValueOnce({ ...info(1, "photos"), recursive: false });
    await openRecent(recent({ includeSubdirs: false, sort: "size" }));
    const [path, recursive, , restore] = openPath.mock.calls[0];
    expect([path, recursive, restore]).toEqual(["/photos", false, true]);
    expect(useListView.getState().sort).toBe("size");
  });

  it("openRecent 打开的目录标记为恢复；普通打开（图片文件、对话框）与刷新不标记", async () => {
    openPath.mockResolvedValueOnce({ ...info(1, "photos"), focus: 5 });
    await openRecent(recent());
    expect(useCatalog.getState().restored).toBe(true);
    openPath.mockResolvedValueOnce({ ...info(2, "dir"), focus: 7 });
    await openFolder("/real/dir/7.jpg");
    expect(useCatalog.getState().restored).toBe(false);
    openPath.mockResolvedValueOnce(info(3, "photos"));
    await openRecent(recent());
    expect(useCatalog.getState().restored).toBe(true);
    openPath.mockResolvedValueOnce(info(4, "photos"));
    await refreshFolder();
    expect(useCatalog.getState().restored).toBe(false);
  });

  it("openRecent 的排序在目录开始（事件回放）之前就已生效", async () => {
    const sortAtBegin: string[] = [];
    const off = useCatalog.subscribe((s, prev) => {
      if (s.root !== prev.root && s.root) sortAtBegin.push(useListView.getState().sort);
    });
    try {
      resolveScanned(1, "/photos");
      await openRecent(recent({ sort: "mtime" }));
      expect(sortAtBegin).toEqual(["mtime"]);
    } finally {
      off();
    }
  });

  it("被取代的 openRecent 不改排序", async () => {
    let resolveFirst!: (i: RootInfo) => void;
    openPath.mockImplementationOnce(() => new Promise<RootInfo>((res) => { resolveFirst = res; }));
    const first = openRecent(recent({ sort: "size" }));
    openPath.mockResolvedValueOnce(info(2, "dir"));
    const second = openFolder("/real/dir");
    await tick();
    resolveFirst(info(1, "photos"));
    await Promise.all([first, second]);
    expect(useCatalog.getState().root?.generation).toBe(2);
    expect(useListView.getState().sort).toBe("name");
  });

  it("openRecent 的项没有记录 includeSubdirs 时按设置打开", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, includeSubdirs: false } });
    openPath.mockResolvedValueOnce({ ...info(1, "photos"), recursive: false });
    await openRecent(recent());
    expect(openPath.mock.calls[0][1]).toBe(false);
    expect(openPath.mock.calls[0][3]).toBe(true);
    expect(useListView.getState().sort).toBe("name");
  });

  it("打开失败时不改排序", async () => {
    openPath.mockRejectedValueOnce({ code: "notFound" });
    await openRecent(recent({ sort: "mtime" }));
    expect(useListView.getState().sort).toBe("name");
  });
});

describe("最近目录的汇报与读取", () => {
  it("打开别的目录之前先 flushRecents", async () => {
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      useListView.getState().setSort("size");   // 扫描结束与改排序引起的汇报都还在去抖中，尚未发出
      expect(recentsNote).not.toHaveBeenCalled();
      openPath.mockResolvedValueOnce(info(2, "other"));
      log.length = 0;
      await openFolder("/other");
      expect(log.indexOf("recentsNote")).toBeGreaterThanOrEqual(0);
      expect(log.indexOf("recentsNote")).toBeLessThan(log.indexOf("openPath:/other"));
      expect(openPath.mock.calls[1][3]).toBe(false);
    } finally {
      stop();
    }
  });

  it("待发的汇报送达之前不调用 openPath", async () => {
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      const note = deferred();
      recentsNote.mockReturnValueOnce(note.promise);
      openPath.mockResolvedValueOnce(info(2, "other"));
      const p = openFolder("/other");
      await tick();
      expect(recentsNote).toHaveBeenCalledTimes(1);
      expect(openPath).toHaveBeenCalledTimes(1);
      note.resolve();
      await p;
      expect(openPath).toHaveBeenCalledTimes(2);
      expect(openPath.mock.calls[1][0]).toBe("/other");
    } finally {
      stop();
    }
  });

  it("先等汇报的打开 A 不会被随后没有汇报可发的打开 B 抢先", async () => {
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      const note = deferred();
      recentsNote.mockReturnValueOnce(note.promise);
      openPath.mockResolvedValueOnce({ ...info(2, "a"), path: "/a" });
      openPath.mockResolvedValueOnce({ ...info(3, "b"), path: "/b" });
      const a = openFolder("/a");
      const b = openFolder("/b");
      await tick();
      expect(openPath).toHaveBeenCalledTimes(1);
      note.resolve();
      await Promise.all([a, b]);
      expect(openPath.mock.calls.slice(1).map((c) => c[0])).toEqual(["/a", "/b"]);
      expect(openPath.mock.calls[1][2]).toBeLessThan(openPath.mock.calls[2][2]);
      expect(useCatalog.getState().root?.path).toBe("/b");
    } finally {
      stop();
    }
  });

  it("汇报失败不妨碍打开", async () => {
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      recentsNote.mockRejectedValueOnce(new Error("boom"));
      openPath.mockResolvedValueOnce(info(2, "other"));
      expect(await openFolder("/other")).toBeNull();
      expect(recentsNote).toHaveBeenCalledTimes(1);
      expect(openPath.mock.calls[1][0]).toBe("/other");
    } finally {
      stop();
    }
  });

  it("汇报一直不落定时，最多等 500 ms 就照常打开", async () => {
    let hung = () => {};
    vi.useFakeTimers();
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      useListView.getState().setSort("size");
      const note = deferred();   // 测试结束时才落定，免得悬着的汇报拖慢后面的测试
      hung = note.resolve;
      recentsNote.mockReturnValueOnce(note.promise);
      openPath.mockResolvedValueOnce(info(2, "other"));
      const p = openFolder("/other");
      await vi.advanceTimersByTimeAsync(499);
      expect(recentsNote).toHaveBeenCalledTimes(1);
      expect(openPath).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBeNull();
      expect(openPath).toHaveBeenCalledTimes(2);
      expect(openPath.mock.calls[1][0]).toBe("/other");
    } finally {
      stop();
      hung();
      vi.useRealTimers();
    }
  });

  it("flush 抛错或拒绝时照常打开，之后的打开也不受影响", async () => {
    flushImpl.current = () => { throw new Error("sync boom"); };
    openPath.mockResolvedValueOnce(info(1, "a"));
    expect(await openFolder("/a")).toBeNull();
    flushImpl.current = () => Promise.reject(new Error("async boom"));
    openPath.mockResolvedValueOnce(info(2, "b"));
    expect(await openFolder("/b")).toBeNull();
    flushImpl.current = null;
    openPath.mockResolvedValueOnce(info(3, "c"));
    expect(await openFolder("/c")).toBeNull();
    expect(openPath.mock.calls.map((c) => c[0])).toEqual(["/a", "/b", "/c"]);
    expect(useCatalog.getState().root?.generation).toBe(3);
  });

  it("刷新（keepView）不带 restore，也不 flush", async () => {
    const stop = startRecentsSync();
    try {
      resolveScanned(1);
      await openFolder("/real/dir");
      useListView.getState().setSort("size");
      resolveScanned(2);
      await refreshFolder();
      expect(openPath.mock.calls[1][3]).toBe(false);
      expect(recentsNote).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("每次打开结束后重新读取最近目录", async () => {
    openPath.mockResolvedValueOnce(info(1, "dir"));
    await openFolder("/real/dir");
    expect(log).toEqual(["openPath:/real/dir", "recentsList"]);
    openPath.mockRejectedValueOnce({ code: "notFound" });
    await openFolder("/gone");
    expect(recentsList).toHaveBeenCalledTimes(2);
    openPath.mockResolvedValueOnce(info(2, "dir"));
    await refreshFolder();
    expect(recentsList).toHaveBeenCalledTimes(3);
  });
});

describe("refreshFolder", () => {
  it("刷新清除损坏标记以便重试，保留就绪状态", async () => {
    openPath.mockResolvedValueOnce(info(1, "dir"));
    await openFolder("/real/dir");
    useThumbs.getState().applyMany([
      { type: "ready", id: 1, tier: 320, v: "1-1" },
      { type: "broken", id: 2 },
    ]);
    openPath.mockResolvedValueOnce(info(2, "dir"));
    await refreshFolder();
    const t = useThumbs.getState();
    expect(t.broken.size).toBe(0);
    expect(t.ready.get(1)).toEqual({ tier: 320, v: "1-1" });
  });

  it("刷新保留原来显示的根目录名（经符号链接打开时后端给的是规范路径）", async () => {
    openPath.mockResolvedValueOnce(info(1, "link"));
    await openFolder("/some/link");
    openPath.mockResolvedValueOnce(info(2, "dir"));
    await refreshFolder();
    const root = useCatalog.getState().root;
    expect(root?.generation).toBe(2);
    expect(root?.name).toBe("link");
    // 普通打开照常用后端给的名字
    openPath.mockResolvedValueOnce(info(3, "dir"));
    await openFolder("/real/dir");
    expect(useCatalog.getState().root?.name).toBe("dir");
  });
});

describe("openFolder", () => {
  it("不传 recursive 时按设置里的 includeSubdirs 打开", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, includeSubdirs: false } });
    openPath.mockResolvedValueOnce({ ...info(1, "dir"), recursive: false });
    await openFolder("/real/dir");
    expect(openPath.mock.calls[0][1]).toBe(false);
    useSettings.setState({ settings: DEFAULT_SETTINGS });
    openPath.mockResolvedValueOnce(info(2, "dir"));
    await openFolder("/real/dir");
    expect(openPath.mock.calls[1][1]).toBe(true);
  });
});

describe("打开失败的提示", () => {
  it("打开失败时显示对应错误的提示条", async () => {
    openPath.mockRejectedValueOnce({ code: "notFound" });
    expect(await openFolder("/gone")).toBe("notFound");
    expect(useToast.getState().current?.text).toBe(t("error.notFound"));
  });

  it("打开成功不显示提示", async () => {
    openPath.mockResolvedValueOnce(info(1, "dir"));
    await openFolder("/real/dir");
    expect(useToast.getState().current).toBeNull();
  });

  it("被取代的打开不显示提示", async () => {
    let rejectFirst!: (e: unknown) => void;
    openPath.mockImplementationOnce(() => new Promise<RootInfo>((_res, rej) => { rejectFirst = rej; }));
    const first = openFolder("/gone");
    openPath.mockResolvedValueOnce(info(2, "dir"));
    const second = openFolder("/real/dir");
    await tick();   // 打开先排队，openPath 稍后才发起
    rejectFirst({ code: "notFound" });
    await Promise.all([first, second]);
    expect(useToast.getState().current).toBeNull();
  });
});
