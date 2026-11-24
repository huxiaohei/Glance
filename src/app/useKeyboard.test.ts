import { afterEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => ({ open: false }));
vi.mock("../ipc/api", () => ({ settingsGet: vi.fn(), settingsSet: vi.fn(() => Promise.resolve()) }));
vi.mock("../views/common/NamePrompt", () => ({ isPromptOpen: () => prompt.open }));

const { registerCommands } = await import("./commands");
type Command = import("./commands").Command;
const { handleKeyDown, useHelp } = await import("./useKeyboard");
const { useSettings } = await import("../stores/settings");
const { useTip } = await import("../stores/tip");
const { IS_MAC } = await import("./keys");

const run = vi.fn();
const runAll = vi.fn();
const runArrow = vi.fn();
const runSpace = vi.fn();
const cmds: Command[] = [
  { id: "app.settings", title: "cmd.app.settings", category: "cmd.cat.general", keys: ["Mod+,"], views: "all", allowInInput: true, run: () => useSettings.setState((s) => ({ open: !s.open })) },
  { id: "t.all", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Mod+A"], views: "all", run: runAll },
  { id: "t.arrow", title: "cmd.app.open", category: "cmd.cat.general", keys: ["ArrowDown"], views: "all", run: runArrow },
  { id: "t.space", title: "cmd.app.open", category: "cmd.cat.general", keys: [" "], views: "all", run: runSpace },
  { id: "help.shortcuts", title: "cmd.help.shortcuts", category: "cmd.cat.general", keys: ["?"], views: "all", run: () => useHelp.setState((s) => ({ open: !s.open })) },
  { id: "esc", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Escape"], views: "all", run },
];
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, target: null, preventDefault: vi.fn(), ...o }) as unknown as KeyboardEvent;

let off = () => {};
const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
afterEach(() => {
  off();
  useHelp.setState({ open: false });
  useSettings.setState({ open: false });
  useTip.setState({ open: false });
  prompt.open = false;
  for (const f of [run, runAll, runArrow, runSpace]) f.mockClear();
});

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

  it("Mod+, 打开设置；再按一次关闭", () => {
    off = registerCommands(cmds);
    const e1 = key(",", mod);
    handleKeyDown(e1);
    expect(useSettings.getState().open).toBe(true);
    expect(e1.preventDefault).toHaveBeenCalled();
    const e2 = key(",", mod);
    handleKeyDown(e2);
    expect(useSettings.getState().open).toBe(false);
    expect(e2.preventDefault).toHaveBeenCalled();
  });
  it("设置打开时 Esc 关闭设置，不触发视图里的 Esc 命令", () => {
    off = registerCommands(cmds);
    useSettings.setState({ open: true });
    const e = key("Escape");
    handleKeyDown(e);
    expect(useSettings.getState().open).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it("设置打开时方向键、空格不被拦下也不执行命令", () => {
    off = registerCommands(cmds);
    useSettings.setState({ open: true });
    const down = key("ArrowDown");
    const space = key(" ");
    handleKeyDown(down);
    handleKeyDown(space);
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(runArrow).not.toHaveBeenCalled();
    expect(runSpace).not.toHaveBeenCalled();
    expect(useSettings.getState().open).toBe(true);
  });
  it("设置打开时 Mod+A 被拦下默认行为但不执行", () => {
    off = registerCommands(cmds);
    useSettings.setState({ open: true });
    const e = key("a", mod);
    handleKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(runAll).not.toHaveBeenCalled();
    // 未注册的组合（留给系统快捷键）原样放过
    const q = key("q", mod);
    handleKeyDown(q);
    expect(q.preventDefault).not.toHaveBeenCalled();
  });
  it("设置打开时优先于快捷键一览：Esc 只关设置", () => {
    off = registerCommands(cmds);
    useSettings.setState({ open: true });
    useHelp.setState({ open: true });
    handleKeyDown(key("Escape"));
    expect(useSettings.getState().open).toBe(false);
    expect(useHelp.getState().open).toBe(true);
  });
  it("打赏面板打开时 Esc 只关闭它，其余命令被拦下", () => {
    off = registerCommands(cmds);
    useTip.setState({ open: true });
    const down = key("ArrowDown");
    handleKeyDown(down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(runArrow).not.toHaveBeenCalled();
    const e = key("Escape");
    handleKeyDown(e);
    expect(useTip.getState().open).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it("名字对话框打开时 Mod+, 不起作用", () => {
    off = registerCommands(cmds);
    prompt.open = true;
    handleKeyDown(key(",", mod));
    expect(useSettings.getState().open).toBe(false);
  });
});
