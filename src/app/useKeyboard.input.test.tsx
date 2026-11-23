// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands, type Command } from "./commands";
import { IS_MAC } from "./keys";
import { handleKeyDown, useHelp } from "./useKeyboard";

vi.mock("../ipc/api", () => ({}));

const runArrow = vi.fn();
const runAll = vi.fn();
const runTab = vi.fn();
const runEsc = vi.fn();
const cmds: Command[] = [
  { id: "help.shortcuts", title: "cmd.help.shortcuts", category: "cmd.cat.general", keys: ["?"], views: "all", run: () => useHelp.setState((s) => ({ open: !s.open })) },
  { id: "t.arrow", title: "cmd.app.open", category: "cmd.cat.general", keys: ["ArrowDown"], views: "all", run: runArrow },
  { id: "t.all", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Mod+A"], views: "all", run: runAll },
  { id: "t.tab", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Tab"], views: "all", run: runTab },
  { id: "t.esc", title: "cmd.app.open", category: "cmd.cat.general", keys: ["Escape"], views: "all", allowInInput: true, run: runEsc },
];

const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };

/** 在 target 上派发一次真实的 keydown（冒泡到 window），返回是否被 preventDefault。 */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): boolean {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

let off = () => {};
let select: HTMLSelectElement;
let input: HTMLInputElement;
beforeEach(() => {
  off = registerCommands(cmds);
  window.addEventListener("keydown", handleKeyDown);
  select = document.createElement("select");
  input = document.createElement("input");
  document.body.append(select, input);
});
afterEach(() => {
  off();
  window.removeEventListener("keydown", handleKeyDown);
  document.body.innerHTML = "";
  useHelp.setState({ open: false });
  for (const f of [runArrow, runAll, runTab, runEsc]) f.mockClear();
});

describe("输入控件聚焦时", () => {
  it("select 上的 ArrowDown 不执行命令，也不拦下默认行为", () => {
    expect(press(select, "ArrowDown")).toBe(false);
    expect(runArrow).not.toHaveBeenCalled();
  });
  it("input 上的 Mod+A 不执行命令，也不拦下默认行为", () => {
    expect(press(input, "a", mod)).toBe(false);
    expect(runAll).not.toHaveBeenCalled();
  });
  it("allowInInput 的命令照常执行", () => {
    expect(press(input, "Escape")).toBe(true);
    expect(runEsc).toHaveBeenCalledTimes(1);
  });
});

describe("命令触发", () => {
  it("执行命令时拦下默认行为（含 Tab）", () => {
    expect(press(document.body, "ArrowDown")).toBe(true);
    expect(press(document.body, "a", mod)).toBe(true);
    expect(press(document.body, "Tab")).toBe(true);
    expect([runArrow, runAll, runTab].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it("没有匹配的命令时不拦下", () => {
    expect(press(document.body, "x")).toBe(false);
  });
});

describe("快捷键一览打开时", () => {
  it("非 Esc、非 ? 的命令被拦下且不执行", () => {
    useHelp.setState({ open: true });
    expect(press(document.body, "ArrowDown")).toBe(true);
    expect(press(document.body, "Tab")).toBe(true);
    expect(runArrow).not.toHaveBeenCalled();
    expect(runTab).not.toHaveBeenCalled();
    expect(useHelp.getState().open).toBe(true);
  });
  it("没有对应命令的 Cmd/Ctrl 组合键不拦也不处理（留给 Cmd+Q、Cmd+W 等系统快捷键）", () => {
    useHelp.setState({ open: true });
    expect(press(document.body, "q", { metaKey: true })).toBe(false);
    expect(press(document.body, "w", { ctrlKey: true })).toBe(false);
    expect(useHelp.getState().open).toBe(true);
  });
  it("对应已注册命令的 Mod 组合键被拦下但不执行（免得 Mod+A 选中页面文字、Ctrl+R 刷新页面）", () => {
    useHelp.setState({ open: true });
    expect(press(document.body, "a", mod)).toBe(true);
    expect(runAll).not.toHaveBeenCalled();
    expect(useHelp.getState().open).toBe(true);
  });
  it("焦点在输入框里时 ? 也能关闭一览", () => {
    useHelp.setState({ open: true });
    press(input, "?", { shiftKey: true });
    expect(useHelp.getState().open).toBe(false);
  });
});
