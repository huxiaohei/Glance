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
      useListView.getState().setSort("size");   // 去抖中，尚未发出
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
    rejectFirst({ code: "notFound" });
    await Promise.all([first, second]);
    expect(useToast.getState().current).toBeNull();
  });
});
