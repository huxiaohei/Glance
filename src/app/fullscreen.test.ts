import { describe, expect, it, vi } from "vitest";

const win = { isFullscreen: vi.fn(), setFullscreen: vi.fn() };
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
import { toggleFullscreen } from "./fullscreen";

describe("toggleFullscreen", () => {
  it("按当前状态取反", async () => {
    win.isFullscreen.mockResolvedValue(false);
    await toggleFullscreen();
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    win.isFullscreen.mockResolvedValue(true);
    await toggleFullscreen();
    expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
  });
  it("出错时吞掉", async () => {
    win.isFullscreen.mockRejectedValue(new Error("no tauri"));
    await expect(toggleFullscreen()).resolves.toBeUndefined();
  });
});
