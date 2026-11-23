import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * 模态弹层的焦点管理：打开时记下原来的焦点元素，把焦点移到容器内第一个可聚焦元素
 * （没有则容器本身，容器需 `tabIndex={-1}`）；Tab / Shift+Tab 在容器内循环；
 * 关闭或卸载时把焦点还给原来的元素（它还在文档里的话）。
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const box = ref.current;
    if (!box) return;
    const restore = document.activeElement;
    (focusables(box)[0] ?? box).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(box);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!box.contains(at) || at === box) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    box.addEventListener("keydown", onKeyDown);
    return () => {
      box.removeEventListener("keydown", onKeyDown);
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    };
  }, [ref, open]);
}
