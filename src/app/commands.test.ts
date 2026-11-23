import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, findCommand, registerCommands, type Command } from "./commands";
import type { KeyLike } from "./keys";

const ev = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o,
});
const cmd = (id: string, keys: string[], o: Partial<Command> = {}): Command => ({
  id, title: "cmd.app.open", category: "cmd.cat.general", keys, views: "all", run: vi.fn(), ...o,
});

let off: (() => void)[] = [];
const reg = (...c: Command[]) => { off.push(registerCommands(c)); };
afterEach(() => { off.forEach((f) => f()); off = []; });

describe("commands", () => {
  it("只返回适用于当前视图的命令", () => {
    reg(cmd("a", ["F5"], { views: ["grid"] }));
    expect(findCommand(ev("F5"), "grid", false, true)?.id).toBe("a");
    expect(findCommand(ev("F5"), "start", false, true)).toBeNull();
  });
  it("输入框内单键命令不触发，allowInInput 的命令照常触发", () => {
    reg(cmd("tab", ["Tab"]), cmd("open", ["Mod+O"], { allowInInput: true }));
    expect(findCommand(ev("Tab"), "grid", true, true)).toBeNull();
    expect(findCommand(ev("Tab"), "grid", false, true)?.id).toBe("tab");
    expect(findCommand(ev("o", { metaKey: true }), "grid", true, true)?.id).toBe("open");
  });
  it("输入框内 Mod+A 不触发全选命令", () => {
    reg(cmd("all", ["Mod+A"]));
    expect(findCommand(ev("a", { metaKey: true }), "grid", true, true)).toBeNull();
    expect(findCommand(ev("a", { metaKey: true }), "grid", false, true)?.id).toBe("all");
  });
  it("id 重复时抛错；注销后可重新注册", () => {
    const off1 = registerCommands([cmd("x", ["F1"])]);
    expect(() => registerCommands([cmd("x", ["F2"])])).toThrow();
    off1();
    expect(allCommands()).toHaveLength(0);
    reg(cmd("x", ["F2"]));
    expect(allCommands().map((c) => c.id)).toEqual(["x"]);
  });
  it("when 返回 false 的命令不被 findCommand 找到", () => {
    let on = false;
    reg(cmd("gated", ["Mod+C"], { when: () => on }), cmd("fallback", ["Mod+C"]));
    expect(findCommand(ev("c", { metaKey: true }), "grid", false, true)?.id).toBe("fallback");
    on = true;
    expect(findCommand(ev("c", { metaKey: true }), "grid", false, true)?.id).toBe("gated");
  });
});
