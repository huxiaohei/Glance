// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { registerCommands } from "../../app/commands";
import { handleKeyDown } from "../../app/useKeyboard";
import NamePrompt, { askName, isPromptOpen } from "./NamePrompt";

const OPTS = { title: "新建子目录", confirm: "移动到这里" };
const input = () => screen.getByRole("textbox", { name: OPTS.title }) as HTMLInputElement;

afterEach(() => {
  // 清掉可能残留的弹层
  if (screen.queryByRole("dialog")) fireEvent.keyDown(input(), { key: "Escape" });
});

function open(): Promise<string | null> {
  let p!: Promise<string | null>;
  act(() => {
    p = askName(OPTS);
  });
  return p;
}

describe("NamePrompt", () => {
  it("回车以输入的名字兑现；Esc 与取消按钮兑现 null", async () => {
    render(<NamePrompt />);
    let p = open();
    fireEvent.change(input(), { target: { value: "abc" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await p).toBe("abc");
    expect(screen.queryByRole("dialog")).toBeNull();

    p = open();
    fireEvent.change(input(), { target: { value: "abc" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(await p).toBeNull();

    p = open();
    fireEvent.click(screen.getByRole("button", { name: t("prompt.cancel") }));
    expect(await p).toBeNull();
  });

  it("点确认按钮兑现名字；点背景兑现 null", async () => {
    render(<NamePrompt />);
    let p = open();
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: OPTS.confirm }));
    expect(await p).toBe("x");
    p = open();
    fireEvent.click(document.querySelector(".prompt-backdrop")!);
    expect(await p).toBeNull();
  });

  it("名字为空时确认按钮不可用，回车无效", async () => {
    render(<NamePrompt />);
    const p = open();
    expect((screen.getByRole("button", { name: OPTS.confirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.change(input(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: OPTS.confirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(await p).toBeNull();
  });

  it("是模态对话框；打开时聚焦输入框，关闭后焦点回到原处", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    render(<NamePrompt />);
    const p = open();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    await p;
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("再次 askName 时上一个以 null 结束，新的取而代之且输入清空", async () => {
    render(<NamePrompt />);
    const first = open();
    fireEvent.change(input(), { target: { value: "old" } });
    const second = open();
    expect(await first).toBeNull();
    expect(input().value).toBe("");
    fireEvent.change(input(), { target: { value: "new" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await second).toBe("new");
  });

  it("Tab 在弹层内循环：最后一个按钮 Tab 回到输入框，输入框 Shift+Tab 到最后一个按钮", async () => {
    render(<NamePrompt />);
    const p = open();
    fireEvent.change(input(), { target: { value: "a" } });
    const confirm = screen.getByRole("button", { name: OPTS.confirm });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(input(), { key: "Escape" });
    await p;
  });

  it("焦点在弹层内非输入处（面板本身）时 Esc 仍取消", async () => {
    render(<NamePrompt />);
    const p = open();
    const panel = screen.getByRole("dialog");
    panel.focus();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(await p).toBeNull();
  });

  it("弹层打开时全局快捷键不执行（即使事件落在 body 上），关闭后恢复", async () => {
    const run = vi.fn();
    const off = registerCommands([{ id: "t.del", title: "cmd.file.trash", category: "cmd.cat.file", keys: ["Delete"], views: "all", run }]);
    render(<NamePrompt />);
    const p = open();
    expect(isPromptOpen()).toBe(true);
    handleKeyDown(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Escape" });
    await p;
    expect(isPromptOpen()).toBe(false);
    handleKeyDown(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(run).toHaveBeenCalledTimes(1);
    off();
  });
});
