import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEvent, RootInfo } from "../ipc/types";

const openPath = vi.fn<(path: string, recursive: boolean, seq: number, onEvent: (e: CatalogEvent) => void) => Promise<RootInfo>>();
vi.mock("../ipc/api", () => ({ openPath: (...a: Parameters<typeof openPath>) => openPath(...a), thumbsSubscribe: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { openFolder, refreshFolder } = await import("./openFolder");
const { useCatalog } = await import("../stores/catalog");
const { useThumbs } = await import("../stores/thumbs");

const info = (generation: number, name: string): RootInfo => ({ generation, path: "/real/dir", name, recursive: true, focus: null });

beforeEach(() => {
  useCatalog.getState().reset();
  useThumbs.getState().reset();
  openPath.mockReset();
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
