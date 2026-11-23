import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileId } from "../ipc/types";
import { useCatalog } from "./catalog";

export type View = { kind: "grid" } | { kind: "single"; source: "folder"; id: FileId };

export interface NavState {
  stack: View[];                       // 栈底恒为 grid
  openSingle(id: FileId): void;        // 栈顶已是 single 时只换 id，否则压栈
  setCurrent(id: FileId): void;        // 栈顶不是 single 时不做事
  back(): void;                        // 弹出栈顶；只剩 grid 时不做事
  reset(): void;                       // 回到只有 grid
}

const GRID: View = { kind: "grid" };
const top = (stack: View[]): View => stack[stack.length - 1];
const single = (id: FileId): View => ({ kind: "single", source: "folder", id });

export const useNav: UseBoundStore<StoreApi<NavState>> = create<NavState>((set) => ({
  stack: [GRID],
  openSingle: (id) =>
    set((s) => {
      const t = top(s.stack);
      if (t.kind !== "single") return { stack: [...s.stack, single(id)] };
      return t.id === id ? s : { stack: [...s.stack.slice(0, -1), single(id)] };
    }),
  setCurrent: (id) =>
    set((s) => {
      const t = top(s.stack);
      if (t.kind !== "single" || t.id === id) return s;
      return { stack: [...s.stack.slice(0, -1), single(id)] };
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
