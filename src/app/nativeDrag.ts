import { dragOut } from "../ipc/api";
import type { FileId } from "../ipc/types";
import { showToast } from "../stores/toast";
import { codeOf, errorText } from "./fileOps";

let active = false;
let seq = 0; // 每次发起加一：上一次拖拽迟到的结束通知不清掉这一次

function clear(): void {
  active = false;
  window.removeEventListener("pointerdown", clear, true);
}

/**
 * 把这些图交给系统拖拽（拖出窗口）。期间 isOwnDragActive 为真，供“拖入打开”忽略自己拖出去的文件。
 * 结束通知、调用被拒绝、页面又收到 pointerdown（系统拖拽期间页面收不到指针事件，收到说明它已结束）三者谁先到谁清除，
 * 不依赖先后（Windows 上结束通知可能早于调用兑现）。ids 为空时什么都不做。
 */
export function startNativeDrag(ids: FileId[]): void {
  if (ids.length === 0) return;
  const mine = ++seq;
  const done = () => {
    if (mine === seq) clear();
  };
  active = true;
  window.addEventListener("pointerdown", clear, { capture: true, once: true });
  dragOut(ids, done).catch((err: unknown) => {
    done();
    showToast({ text: errorText(codeOf(err)) });
  });
}

/** 自己发起的系统拖拽是否还在进行。 */
export function isOwnDragActive(): boolean {
  return active;
}
