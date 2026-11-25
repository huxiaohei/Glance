// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { registerBasketCommands } from "../../app/basketCommands";
import { registerCommands } from "../../app/commands";
import { registerCompareCommands } from "../../views/compare/compareCommands";
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

  it("没有快捷键的命令不列出", () => {
    off = registerCommands([
      { id: "t.nokey", title: "cmd.view.refresh", category: "cmd.cat.view", keys: [], views: "all", run() {} },
      { id: "t.full", title: "cmd.view.fullscreen", category: "cmd.cat.view", keys: ["F"], views: "all", run() {} },
    ]);
    useHelp.setState({ open: true });
    const { container } = render(<ShortcutsOverlay />);
    const rows = [...container.querySelectorAll(".help-row > span")].map((r) => r.textContent);
    expect(rows).toEqual([t("cmd.view.fullscreen")]);
  });

  it("关闭时不渲染", () => {
    const { container } = render(<ShortcutsOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it("有 aria-modal，打开后焦点在面板内，关闭后焦点还原", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<ShortcutsOverlay />);
    act(() => useHelp.setState({ open: true }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => useHelp.setState({ open: false }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("对比命令出现在“对比”分类里，空格显示为 Space", () => {
    const offA = registerBasketCommands();
    const offB = registerCompareCommands();
    off = () => { offA(); offB(); };
    useHelp.setState({ open: true });
    const { container } = render(<ShortcutsOverlay />);
    const group = [...container.querySelectorAll(".help-group")].find(
      (g) => g.querySelector(".help-cat")!.textContent === t("cmd.cat.compare"),
    )!;
    expect(group).toBeTruthy();
    const rows = [...group.querySelectorAll(".help-row")].map((r) => [r.querySelector("span")!.textContent, r.querySelector("kbd")!.textContent]);
    expect(rows).toContainEqual([t("cmd.basket.toggle"), "Space"]);
    expect(rows).toContainEqual([t("cmd.basket.open"), "C"]);
    expect(rows).toContainEqual([t("cmd.compare.toggleSync"), "S"]);
  });

  it("help_lists_edit_group：编辑类别列出打开、保存、取消，保存与取消标“编辑中”", async () => {
    const { registerEditCommands } = await import("../edit/editCommands");
    off = registerEditCommands();
    useHelp.setState({ open: true });
    const { container } = render(<ShortcutsOverlay />);
    const g = [...container.querySelectorAll(".help-group")].find(
      (x) => x.querySelector(".help-cat")!.textContent === t("cmd.cat.edit"),
    )!;
    expect(g).toBeTruthy();
    expect([...g.querySelectorAll(".help-row > span")].map((r) => r.textContent)).toEqual([
      t("cmd.edit.open"), t("cmd.edit.save"), t("cmd.edit.cancel"),
    ]);
    expect([...g.querySelectorAll(".help-view")].map((r) => r.textContent)).toEqual([t("help.view.single"), t("help.view.edit")]);
  });
});
