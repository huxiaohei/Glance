import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { t } from "../../i18n";
import "./prompt.css";

interface PromptState {
  title: string;
  confirm: string;
  resolve: (name: string | null) => void;
  /** 打开之前拥有焦点的元素，关闭后还给它 */
  restore: Element | null;
  /** 第几次弹出：被顶替时换 key 重新挂载，输入内容清空 */
  seq: number;
}

let seq = 0;

const usePrompt = create<{ current: PromptState | null }>(() => ({ current: null }));

function close(name: string | null): void {
  const cur = usePrompt.getState().current;
  if (!cur) return;
  usePrompt.setState({ current: null });
  cur.resolve(name);
  if (cur.restore instanceof HTMLElement) cur.restore.focus();
}

/** 名称输入框是否正在显示（全局快捷键据此让路） */
export function isPromptOpen(): boolean {
  return usePrompt.getState().current !== null;
}

/** 弹出名称输入框；确定返回输入的名字，取消返回 null。同一时间只有一个：再次调用会以 null 结束上一个并取而代之。 */
export function askName(opts: { title: string; confirm: string }): Promise<string | null> {
  const prev = usePrompt.getState().current;
  // 上一个被顶替：它的焦点还原目标沿用，不让焦点落到已消失的输入框上
  const restore = prev ? prev.restore : document.activeElement;
  if (prev) prev.resolve(null);
  return new Promise((resolve) => {
    usePrompt.setState({ current: { ...opts, resolve, restore, seq: ++seq } });
  });
}

function PromptBody({ title, confirm }: { title: string; confirm: string }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = value.trim() !== "";

  const panel = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      // 焦点留在弹层里：首尾循环
      const items = [...panel.current!.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!panel.current!.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== "Enter" && e.key !== "Escape") return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(null);
    } else if (e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (ok) close(value);
    }
  };

  return (
    <div className="prompt-backdrop" onClick={() => close(null)}>
      <div ref={panel} className="prompt-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 className="prompt-title">{title}</h2>
        <input
          ref={ref}
          className="prompt-input"
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={title}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="prompt-actions">
          <button type="button" onClick={() => close(null)}>
            {t("prompt.cancel")}
          </button>
          <button type="button" className="prompt-confirm" disabled={!ok} onClick={() => close(value)}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function NamePrompt() {
  const cur = usePrompt((s) => s.current);
  return cur ? <PromptBody key={cur.seq} title={cur.title} confirm={cur.confirm} /> : null;
}
