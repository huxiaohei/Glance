import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentEntry } from "../ipc/types";

const recentsList = vi.fn<() => Promise<RecentEntry[]>>();
const recentsPin = vi.fn<(path: string, pinned: boolean) => Promise<RecentEntry[]>>();
const recentsRemove = vi.fn<(path: string) => Promise<RecentEntry[]>>();
vi.mock("../ipc/api", () => ({
  recentsList: () => recentsList(),
  recentsPin: (p: string, pinned: boolean) => recentsPin(p, pinned),
  recentsRemove: (p: string) => recentsRemove(p),
}));

const { loadRecents, pinRecent, removeRecent, useRecents } = await import("./recents");

const entry = (path: string, pinned = false): RecentEntry => ({
  path, name: path.split("/").pop() ?? path, count: 3, thumbs: [], pinned, exists: true, sort: null, includeSubdirs: null,
});

beforeEach(() => {
  recentsList.mockReset();
  recentsPin.mockReset();
  recentsRemove.mockReset();
  useRecents.setState({ list: [] });
});

describe("recents store", () => {
  it("loadRecents 把后端列表写进 store；后端拒绝时保留原列表", async () => {
    const list = [entry("/a"), entry("/b")];
    recentsList.mockResolvedValueOnce(list);
    await loadRecents();
    expect(useRecents.getState().list).toEqual(list);
    recentsList.mockRejectedValueOnce(new Error("boom"));
    await expect(loadRecents()).resolves.toBeUndefined();
    expect(useRecents.getState().list).toEqual(list);
  });

  it("pinRecent 与 removeRecent 用后端返回的列表替换 store", async () => {
    useRecents.setState({ list: [entry("/a"), entry("/b")] });
    recentsPin.mockResolvedValueOnce([entry("/b", true), entry("/a")]);
    await pinRecent("/b", true);
    expect(recentsPin).toHaveBeenCalledWith("/b", true);
    expect(useRecents.getState().list).toEqual([entry("/b", true), entry("/a")]);

    recentsRemove.mockResolvedValueOnce([entry("/b", true)]);
    await removeRecent("/a");
    expect(recentsRemove).toHaveBeenCalledWith("/a");
    expect(useRecents.getState().list).toEqual([entry("/b", true)]);

    // 失败时保持原列表，不抛
    recentsPin.mockRejectedValueOnce("x");
    recentsRemove.mockRejectedValueOnce("x");
    await expect(pinRecent("/b", false)).resolves.toBeUndefined();
    await expect(removeRecent("/b")).resolves.toBeUndefined();
    expect(useRecents.getState().list).toEqual([entry("/b", true)]);
  });
});
