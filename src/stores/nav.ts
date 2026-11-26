import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileId } from "../ipc/types";
import { useCatalog } from "./catalog";

/** 单张视图的来源：folder 是当前目录的列表，basket 是对比篮，selection 是批量模式里选中的图。 */
export type SingleSource = "folder" | "basket" | "selection";

export type View =
  | { kind: "grid" }
  | { kind: "compare" }
  | { kind: "single"; source: SingleSource; id: FileId };

export interface NavState {
  stack: View[];                       // 栈底恒为 grid
  /** source 默认 "folder"。栈顶已是 single 时原地换成 (id, source)（界面上不会跨来源，不另压一层），否则压栈 */
  openSingle(id: FileId, source?: SingleSource): void;
  /** 栈顶已是 compare 时不做事；栈顶是 basket 来源的 single 时等同 back()（对比之上最多一层单张）；否则压栈 */
  openCompare(): void;
  setCurrent(id: FileId): void;        // 栈顶不是 single 时不做事；来源不变
  back(): void;                        // 弹出栈顶；只剩 grid 时不做事
  reset(): void;                       // 回到只有 grid
}

const GRID: View = { kind: "grid" };
const top = (stack: View[]): View => stack[stack.length - 1];
const COMPARE: View = { kind: "compare" };
const single = (id: FileId, source: SingleSource): View => ({ kind: "single", source, id });

export const useNav: UseBoundStore<StoreApi<NavState>> = create<NavState>((set) => ({
  stack: [GRID],
  openSingle: (id, source = "folder") =>
    set((s) => {
      const t = top(s.stack);
      if (t.kind !== "single") return { stack: [...s.stack, single(id, source)] };
      return t.id === id && t.source === source ? s : { stack: [...s.stack.slice(0, -1), single(id, source)] };
    }),
  openCompare: () =>
    set((s) => {
      const t = top(s.stack);
      if (t.kind === "compare") return s;
      if (t.kind === "single" && t.source === "basket") return { stack: s.stack.slice(0, -1) };
      return { stack: [...s.stack, COMPARE] };
    }),
  setCurrent: (id) =>
    set((s) => {
      const t = top(s.stack);
      if (t.kind !== "single" || t.id === id) return s;
      return { stack: [...s.stack.slice(0, -1), single(id, t.source)] };
    }),
  back: () => set((s) => (s.stack.length <= 1 ? s : { stack: s.stack.slice(0, -1) })),
  reset: () => set((s) => (s.stack.length === 1 ? s : { stack: [GRID] })),
}));

export function topView(): View {
  return top(useNav.getState().stack);
}

// 换目录（路径变化）时回到网格；刷新同一目录保留。与选中的清空条件一致
useCatalog.subscribe((state, prev) => {
  if (state.root?.path !== prev.root?.path && state.root?.generation !== prev.root?.generation) {
    useNav.getState().reset();
  }
});
