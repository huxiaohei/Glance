import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, findCommand } from "./commands";
import { fileCommands, registerFileCommands } from "./fileCommands";
import { trashTargets, undoLast } from "./fileOps";

vi.mock("./fileOps", () => ({ trashTargets: vi.fn(), undoLast: vi.fn() }));

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
  vi.clearAllMocks();
});

describe("file commands", () => {
  it("file.trash 在 macOS 上绑定 Mod+Backspace，在其他平台绑定 Delete", () => {
    const mac = fileCommands(true).find((c) => c.id === "file.trash")!;
    const other = fileCommands(false).find((c) => c.id === "file.trash")!;
    expect(mac.keys).toEqual(["Mod+Backspace", "Mod+Delete"]);
    expect(other.keys).toEqual(["Delete"]);
    expect(mac.views).toEqual(["grid", "single"]);
  });

  it("file.trash 调用 trashTargets，忽略自动重复", () => {
    off = registerFileCommands(true);
    const cmd = findCommand(key("Backspace", { metaKey: true }), "grid", false, true);
    expect(cmd?.id).toBe("file.trash");
    cmd!.run({ shift: false, repeat: true });
    expect(trashTargets).not.toHaveBeenCalled();
    cmd!.run({ shift: false, repeat: false });
    expect(trashTargets).toHaveBeenCalledTimes(1);
  });

  it("file.undo 用于所有视图，调用 undoLast，忽略自动重复", () => {
    off = registerFileCommands(false);
    const cmd = findCommand(key("z", { ctrlKey: true }), "single", false, false);
    expect(cmd?.id).toBe("file.undo");
    expect(allCommands().find((c) => c.id === "file.undo")?.views).toBe("all");
    cmd!.run({ shift: false, repeat: true });
    expect(undoLast).not.toHaveBeenCalled();
    cmd!.run({ shift: false, repeat: false });
    expect(undoLast).toHaveBeenCalledTimes(1);
  });

  it("file.undo 在输入框聚焦时不触发", () => {
    off = registerFileCommands(true);
    expect(findCommand(key("z", { metaKey: true }), "grid", true, true)).toBeNull();
    expect(findCommand(key("z", { metaKey: true }), "grid", false, true)?.id).toBe("file.undo");
  });
});
