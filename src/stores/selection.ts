import { create } from "zustand";
import { EMPTY, prune, type Selection } from "../lib/selection";
import { useCatalog } from "./catalog";

export interface SelectionState extends Selection { set(next: Selection): void; clear(): void }

export const useSelection = create<SelectionState>((set) => ({
  ...EMPTY,
  set: (next) => set({ ids: next.ids, focus: next.focus, anchor: next.anchor }),
  clear: () => set((s) => (s.ids === EMPTY.ids && s.focus === null && s.anchor === null ? s : { ...EMPTY })),
}));

// 条目集合变化时修剪选中；换目录（路径变化）时清空，刷新同一目录保留。两者顺序无关。
useCatalog.subscribe((state, prev) => {
  if (state.root?.path !== prev.root?.path && state.root?.generation !== prev.root?.generation) {
    useSelection.getState().clear();
  }
  if (state.listVersion !== prev.listVersion) {
    const cur = useSelection.getState();
    if (cur.ids.size === 0 && cur.focus === null && cur.anchor === null) return;
    const next = prune(cur, new Set(state.entries.keys()));
    if (next.ids !== cur.ids || next.focus !== cur.focus || next.anchor !== cur.anchor) cur.set(next);
  }
});
