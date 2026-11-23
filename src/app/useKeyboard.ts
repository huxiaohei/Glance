import { useEffect } from "react";
import { create } from "zustand";
import { activeView, findCommand } from "./commands";
import { IS_MAC } from "./keys";

export const useHelp = create<{ open: boolean }>(() => ({ open: false }));

function isInInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true;
}

/**
 * window 上的 keydown 处理：快捷键一览打开时只响应 help.shortcuts 与 Esc，其余全部拦下。
 * 按住 Cmd 或 Ctrl 的按键：对应已注册的命令时只拦下默认行为、不执行（免得 Mod+A 选中
 * 页面文字、Ctrl+R 刷新页面）；否则原样放过，留给 Cmd+Q、Cmd+W 等系统快捷键。
 */
export function handleKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.key === "Process") return;
  const inInput = isInInput(e.target);
  const view = activeView();
  if (useHelp.getState().open) {
    // 一览打开时焦点在输入框里，? 也要能关闭它：按不在输入框里查找
    const cmd = findCommand(e, view, false, IS_MAC);
    if (e.metaKey || e.ctrlKey) {
      if (cmd) e.preventDefault();
      return;
    }
    if (e.key === "Escape" || cmd?.id === "help.shortcuts") useHelp.setState({ open: false });
    e.preventDefault();
    return;
  }
  const cmd = findCommand(e, view, inInput, IS_MAC);
  if (!cmd) return;
  e.preventDefault();
  cmd.run({ shift: e.shiftKey, repeat: e.repeat });
}

export function useKeyboard(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
