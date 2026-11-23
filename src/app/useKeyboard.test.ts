import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommands, type Command } from "./commands";
import { handleKeyDown, useHelp } from "./useKeyboard";

const run = vi.fn();
const cmds: Command[] = [
  { id: "help.shortcuts", title: "cmd.help.shortcuts", category: "cmd.cat.general", keys: ["?"], views: "all", run: () => useHelp.setState((s) => ({ open: !s.open })) },
  { id: "esc", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Escape"], views: "all", run },
];
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, target: null, preventDefault: vi.fn(), ...o }) as unknown as KeyboardEvent;

let off = () => {};
afterEach(() => { off(); useHelp.setState({ open: false }); run.mockClear(); });

describe("handleKeyDown", () => {
  it("一览关闭时 Escape 是普通命令", () => {
    off = registerCommands(cmds);
    handleKeyDown(key("Escape"));
    expect(run).toHaveBeenCalled();
  });
  it("一览打开时 Escape 只关闭它，其他命令被拦下", () => {
    off = registerCommands(cmds);
    useHelp.setState({ open: true });
    handleKeyDown(key("Escape"));
    expect(useHelp.getState().open).toBe(false);
    expect(run).not.toHaveBeenCalled();
    useHelp.setState({ open: true });
    handleKeyDown(key("?"));
    expect(useHelp.getState().open).toBe(false);
  });
  it("输入法组合中的按键被忽略", () => {
    off = registerCommands(cmds);
    handleKeyDown(key("Escape", { isComposing: true }));
    handleKeyDown(key("Process"));
    expect(run).not.toHaveBeenCalled();
  });
});
