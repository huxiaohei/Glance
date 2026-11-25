import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCommand } from "../../app/commands";
import { topView, useNav } from "../../stores/nav";
import { registerCompareCommands } from "./compareCommands";

let off = () => {};
beforeEach(() => {
  off = registerCompareCommands();
  useNav.getState().reset();
  useNav.getState().openCompare();
});
afterEach(() => off());

const esc = { key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("对比视图命令", () => {
  it("Esc 在对比视图里返回进入前的视图", () => {
    const cmd = findCommand(esc, "compare", false, true);
    expect(cmd?.id).toBe("compare.back");
    cmd!.run({ shift: false, repeat: false });
    expect(topView().kind).toBe("grid");
  });

  it("按住 Esc 的自动重复不返回", () => {
    findCommand(esc, "compare", false, true)!.run({ shift: false, repeat: true });
    expect(topView().kind).toBe("compare");
  });

  it("只在对比视图里生效", () => {
    expect(findCommand(esc, "grid", false, true)?.id).not.toBe("compare.back");
  });
});
