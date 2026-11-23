import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, findCommand } from "./commands";
import { fileCommands, registerFileCommands } from "./fileCommands";
import { startRename } from "../stores/rename";
import { pickAndTransfer, transferToNewChild, trashTargets, undoLast } from "./fileOps";

vi.mock("./fileOps", () => ({ trashTargets: vi.fn(), undoLast: vi.fn(), pickAndTransfer: vi.fn(), transferToNewChild: vi.fn() }));
vi.mock("../stores/rename", () => ({ startRename: vi.fn() }));

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

  it("file.rename 用 F2，用于网格与单张视图，调用 startRename，输入框聚焦时不触发", () => {
    off = registerFileCommands(true);
    expect(findCommand(key("F2"), "single", false, true)?.id).toBe("file.rename");
    expect(findCommand(key("F2"), "grid", true, true)).toBeNull();
    const cmd = findCommand(key("F2"), "grid", false, true)!;
    expect(cmd.views).toEqual(["grid", "single"]);
    cmd.run({ shift: false, repeat: false });
    expect(startRename).toHaveBeenCalledWith();
  });

  it("移动与复制命令没有快捷键，分别调用 pickAndTransfer 与 transferToNewChild", () => {
    const cmds = fileCommands(true);
    const ctx = { repeat: false } as never;
    for (const id of ["file.moveTo", "file.copyTo", "file.moveToNew"]) expect(cmds.find((c) => c.id === id)!.keys).toEqual([]);
    cmds.find((c) => c.id === "file.moveTo")!.run(ctx);
    cmds.find((c) => c.id === "file.copyTo")!.run(ctx);
    cmds.find((c) => c.id === "file.moveToNew")!.run(ctx);
    expect(pickAndTransfer).toHaveBeenNthCalledWith(1, "move");
    expect(pickAndTransfer).toHaveBeenNthCalledWith(2, "copy");
    expect(transferToNewChild).toHaveBeenCalledWith("move");
  });
});
