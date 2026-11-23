import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppCommands } from "./appCommands";
import { allCommands, findCommand } from "./commands";

vi.mock("./fullscreen", () => ({ toggleFullscreen: vi.fn() }));
vi.mock("./openFolder", () => ({ pickAndOpenFolder: vi.fn(), refreshFolder: vi.fn() }));
vi.mock("../ipc/api", () => ({ settingsGet: vi.fn(), settingsSet: vi.fn(() => Promise.resolve()) }));
import { toggleFullscreen } from "./fullscreen";
import { useSettings } from "../stores/settings";

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
  vi.clearAllMocks();
});

describe("view.fullscreen", () => {
  it("F 在各视图调用 toggleFullscreen，按住自动重复时忽略", () => {
    unregister = registerAppCommands();
    const cmd = findCommand({ key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent, "single", false, true);
    expect(cmd?.id).toBe("view.fullscreen");
    expect(allCommands().find((c) => c.id === "view.fullscreen")?.views).toBe("all");
    cmd!.run({ shift: false, repeat: true });
    expect(toggleFullscreen).not.toHaveBeenCalled();
    cmd!.run({ shift: false, repeat: false });
    expect(toggleFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe("app.settings", () => {
  it("Mod+, 在各视图（含输入框里）切换设置对话框", () => {
    unregister = registerAppCommands();
    const cmd = findCommand({ key: ",", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent, "single", true, true);
    expect(cmd?.id).toBe("app.settings");
    expect(cmd?.views).toBe("all");
    cmd!.run({ shift: false, repeat: false });
    expect(useSettings.getState().open).toBe(true);
    cmd!.run({ shift: false, repeat: false });
    expect(useSettings.getState().open).toBe(false);
  });
});
