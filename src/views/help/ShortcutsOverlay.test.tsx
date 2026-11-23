// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { registerCommands } from "../../app/commands";
import { useHelp } from "../../app/useKeyboard";
import { t } from "../../i18n";
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
  it("同一分类下按适用视图分组，每组标出视图（网格 / 单张 / 全部）", () => {
    off = registerCommands([
      { id: "t.gridNext", title: "cmd.nav.right", category: "cmd.cat.nav", keys: ["ArrowRight"], views: ["grid"], run() {} },
      { id: "t.singleNext", title: "cmd.single.next", category: "cmd.cat.nav", keys: ["ArrowRight"], views: ["single"], run() {} },
      { id: "t.gridLeft", title: "cmd.nav.left", category: "cmd.cat.nav", keys: ["ArrowLeft"], views: ["grid"], run() {} },
      { id: "t.full", title: "cmd.view.fullscreen", category: "cmd.cat.view", keys: ["F"], views: "all", run() {} },
    ]);
    useHelp.setState({ open: true });
    const { container } = render(<ShortcutsOverlay />);
    const groups = [...container.querySelectorAll(".help-group")];
    expect(groups.map((g) => g.querySelector(".help-cat")!.textContent)).toEqual([t("cmd.cat.nav"), t("cmd.cat.view")]);
    const sub = (g: Element) =>
      [...g.querySelectorAll(".help-view-group")].map((v) => ({
        view: v.querySelector(".help-view")!.textContent,
        rows: [...v.querySelectorAll(".help-row > span")].map((r) => r.textContent),
      }));
    expect(sub(groups[0])).toEqual([
      { view: t("help.view.grid"), rows: [t("cmd.nav.right"), t("cmd.nav.left")] },
      { view: t("help.view.single"), rows: [t("cmd.single.next")] },
    ]);
    expect(sub(groups[1])).toEqual([{ view: t("help.view.all"), rows: [t("cmd.view.fullscreen")] }]);
  });

  it("关闭时不渲染", () => {
    const { container } = render(<ShortcutsOverlay />);
    expect(container.firstChild).toBeNull();
  });
});
