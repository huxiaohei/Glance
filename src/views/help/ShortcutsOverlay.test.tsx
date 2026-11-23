// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { registerCommands } from "../../app/commands";
import { useHelp } from "../../app/useKeyboard";
import ShortcutsOverlay from "./ShortcutsOverlay";

let off = () => {};
afterEach(() => { off(); useHelp.setState({ open: false }); });

describe("ShortcutsOverlay", () => {
  it("列出已注册的命令及其按键", () => {
    off = registerCommands([
      { id: "t.refresh", title: "cmd.view.refresh", category: "cmd.cat.view", keys: ["F5"], views: "all", run() {} },
    ]);
    useHelp.setState({ open: true });
    render(<ShortcutsOverlay />);
    expect(screen.getByText(/刷新|Refresh/)).not.toBeNull();
    expect(screen.getByText("F5")).not.toBeNull();
  });
  it("关闭时不渲染", () => {
    const { container } = render(<ShortcutsOverlay />);
    expect(container.firstChild).toBeNull();
  });
});
