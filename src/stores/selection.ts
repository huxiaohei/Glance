import { create } from "zustand";
import { EMPTY, prune, type Selection } from "../lib/selection";
import type { FileId } from "../ipc/types";
import type { ImageEntry } from "../lib/deriveList";
import { useCatalog } from "./catalog";
import { useGridCtx } from "./gridCtx";
import { useListView } from "./listView";

export interface SelectionState extends Selection { set(next: Selection): void; clear(): void }

export const useSelection = create<SelectionState>((set) => ({
  ...EMPTY,
  set: (next) => set({ ids: next.ids, focus: next.focus, anchor: next.anchor }),
  clear: () => set((s) => (s.ids === EMPTY.ids && s.focus === null && s.anchor === null ? s : { ...EMPTY })),
}));

// 条目集合变化时修剪选中（焦点所在的图没了就落到相邻的图：网格的列表在 GridView 渲染时才更新，
// 此刻读到的还是变化前的顺序）；换目录（路径变化）时清空，刷新同一目录保留。两者顺序无关。
useCatalog.subscribe((state, prev) => {
  if (state.root?.path !== prev.root?.path && state.root?.generation !== prev.root?.generation) {
    useSelection.getState().clear();
  }
  if (state.listVersion !== prev.listVersion) {
    const cur = useSelection.getState();
    if (cur.ids.size === 0 && cur.focus === null && cur.anchor === null) return;
    const next = prune(cur, state.entries, useGridCtx.getState().list.ids);
    if (next.ids !== cur.ids || next.focus !== cur.focus || next.anchor !== cur.anchor) cur.set(next);
  }
});

/** 有条目位于 dir 或其下级目录。 */
function hasEntriesUnder(entries: ReadonlyMap<FileId, ImageEntry>, dir: string): boolean {
  const prefix = dir + "/";
  for (const e of entries.values()) if (e.dir === dir || e.dir.startsWith(prefix)) return true;
  return false;
}

// 目录树选中的目录被删除或改名（它和它的下级都没有条目了）时回到“全部图片”；根目录（""）不受影响
useCatalog.subscribe((state, prev) => {
  if (state.listVersion === prev.listVersion) return;
  const dir = useListView.getState().dirFilter;
  if (dir === null || dir === "" || hasEntriesUnder(state.entries, dir)) return;
  useListView.getState().setDirFilter(null);
});
