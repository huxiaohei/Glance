// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands, type Command } from "../../app/commands";
import { setLanguage, t } from "../../i18n";
import KeyHints from "./KeyHints";

vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

const cmd = (id: string, keys: string[]): Command => ({
  id, keys, title: "cmd.basket.toggle", category: "cmd.cat.compare", views: "all", run: () => {},
});

let offs: (() => void)[] = [];
beforeEach(() => setLanguage("zh-CN"));
afterEach(() => {
  for (const off of offs) off();
  offs = [];
});

const rows = (c: HTMLElement) =>
  [...c.querySelectorAll(".key-hint")].map((h) => ({
    keys: [...h.querySelectorAll("kbd")].map((k) => k.textContent),
    text: h.querySelector(".key-hint-text")?.textContent,
  }));

describe("KeyHints", () => {
  it("键名取自命令表，带数量的文字插值", () => {
    offs.push(registerCommands([cmd("basket.toggle", [" "]), cmd("basket.open", ["C"])]));
    const { container } = render(<KeyHints hints={[{ id: "basket.add", n: 2 }, { id: "compare.open", n: 5 }]} />);
    expect(container.querySelector(".key-hints")!.getAttribute("role")).toBe("note");
    expect(rows(container)).toEqual([
      { keys: ["Space"], text: t("hint.basket.add", { n: 2 }) },
      { keys: ["C"], text: t("hint.compare.open", { n: 5 }) },
    ]);
  });

  it("加入对比没有数量时用不带数量的文字", () => {
    offs.push(registerCommands([cmd("basket.toggle", [" "])]));
    const { container } = render(<KeyHints hints={[{ id: "basket.add" }, { id: "basket.remove" }]} />);
    expect(rows(container).map((r) => r.text)).toEqual([t("hint.basket.add1"), t("hint.basket.remove")]);
  });

  it("命令未注册的那条不渲染；全都不渲染时整条不出现", () => {
    offs.push(registerCommands([cmd("grid.open", ["Enter"])]));
    const { container, rerender } = render(<KeyHints hints={[{ id: "basket.add", n: 1 }, { id: "grid.open" }]} />);
    expect(rows(container)).toEqual([{ keys: ["Enter"], text: t("hint.grid.open") }]);
    rerender(<KeyHints hints={[{ id: "basket.add", n: 1 }]} />);
    expect(container.querySelector(".key-hints")).toBeNull();
  });

  it("切换用上一张与下一张两个键；缺一个就不显示", () => {
    offs.push(registerCommands([cmd("single.prev", ["ArrowLeft"])]));
    const { container, rerender } = render(<KeyHints hints={[{ id: "single.switch" }]} />);
    expect(rows(container)).toEqual([]);
    offs.push(registerCommands([cmd("single.next", ["ArrowRight"])]));
    rerender(<KeyHints hints={[{ id: "single.switch" }]} />);
    expect(rows(container)).toEqual([{ keys: ["←", "→"], text: t("hint.single.switch") }]);
  });

  it("对比：同步开关取命令表；移出在 Mac 上显示退格；缩放与平移不是命令", () => {
    offs.push(registerCommands([cmd("compare.toggleSync", ["S"]), cmd("compare.remove", ["Delete", "Backspace"])]));
    const { container } = render(
      <KeyHints hints={[{ id: "compare.zoom" }, { id: "compare.pan" }, { id: "compare.sync" }, { id: "compare.remove" }]} />,
    );
    expect(rows(container)).toEqual([
      { keys: [`⌘ ${t("hint.key.wheel")}`], text: t("hint.compare.zoom") },
      { keys: [t("hint.key.drag")], text: t("hint.compare.pan") },
      { keys: ["S"], text: t("hint.compare.sync") },
      { keys: ["⌫"], text: t("hint.compare.remove") },
    ]);
  });

  it("面板移动焦点显示四个方向键；缺一个就不显示", () => {
    offs.push(registerCommands([
      cmd("compare.focusLeft", ["ArrowLeft"]),
      cmd("compare.focusRight", ["ArrowRight"]),
      cmd("compare.focusUp", ["ArrowUp"]),
    ]));
    const { container, rerender } = render(<KeyHints hints={[{ id: "panel.move" }]} />);
    expect(rows(container)).toEqual([]);
    offs.push(registerCommands([cmd("compare.focusDown", ["ArrowDown"])]));
    rerender(<KeyHints hints={[{ id: "panel.move" }]} />);
    expect(rows(container)).toEqual([{ keys: ["←", "→", "↑", "↓"], text: t("hint.panel.move") }]);
  });

  it("没有提示时不渲染", () => {
    const { container } = render(<KeyHints hints={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("命令晚于组件注册时，不需要别的状态变化，提示随之出现；注销后消失", () => {
    const { container } = render(<KeyHints hints={[{ id: "grid.open" }]} />);
    expect(rows(container)).toEqual([]);
    let off = () => {};
    act(() => {
      off = registerCommands([cmd("grid.open", ["Enter"])]);
    });
    expect(rows(container)).toEqual([{ keys: ["Enter"], text: t("hint.grid.open") }]);
    act(() => off());
    expect(container.querySelector(".key-hints")).toBeNull();
  });

  it("键名对读屏隐藏，动作文字可读", () => {
    offs.push(registerCommands([cmd("grid.open", ["Enter"])]));
    const { container } = render(<KeyHints hints={[{ id: "grid.open" }]} />);
    const kbd = container.querySelector("kbd")!;
    expect(kbd.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".key-hint-text")!.getAttribute("aria-hidden")).toBeNull();
  });

  it("同步关时缩放提示用不带“同步”的文字", () => {
    const { container } = render(<KeyHints hints={[{ id: "compare.zoom", solo: true }]} />);
    expect(rows(container)).toEqual([{ keys: [`⌘ ${t("hint.key.wheel")}`], text: t("hint.compare.zoomSolo") }]);
    expect(t("hint.compare.zoomSolo")).toBe("缩放");
  });

  it("编辑提示的键名取自 edit.save / edit.cancel", () => {
    offs.push(registerCommands([cmd("edit.save", ["Enter"]), cmd("edit.cancel", ["Escape"])]));
    const { container } = render(<KeyHints hints={[{ id: "edit.save" }, { id: "edit.cancel" }]} />);
    expect(rows(container)).toEqual([
      { keys: ["Enter"], text: t("hint.edit.save") },
      { keys: ["Escape"], text: t("hint.edit.cancel") },
    ]);
  });
});
