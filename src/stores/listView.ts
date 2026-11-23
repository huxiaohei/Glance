import { create } from "zustand";
import type { SortKey } from "../lib/deriveList";

export const CELL_MIN = 96, CELL_MAX = 320, CELL_DEFAULT = 160;

export interface ListViewState {
  sort: SortKey;
  includeSubdirs: boolean;
  dirFilter: string | null;        // 目录树选中的目录；null 为“全部图片”
  collapsed: Set<string>;          // 折叠的分组（dir）
  cell: number;
  treeVisible: boolean;
  setSort(s: SortKey): void;
  setIncludeSubdirs(v: boolean): void;
  setDirFilter(dir: string | null): void;
  toggleCollapsed(dir: string): void;
  setCell(px: number): void;       // 取整并夹到 [CELL_MIN, CELL_MAX]
  resetForNewRoot(includeSubdirs: boolean): void;   // 清空筛选和折叠，保留排序与格子大小
}

export const useListView = create<ListViewState>((set) => ({
  sort: "name",
  includeSubdirs: true,
  dirFilter: null,
  collapsed: new Set(),
  cell: CELL_DEFAULT,
  treeVisible: true,

  setSort: (sort) => set({ sort }),
  setIncludeSubdirs: (includeSubdirs) => set({ includeSubdirs }),
  setDirFilter: (dirFilter) => set({ dirFilter }),
  toggleCollapsed: (dir) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (!collapsed.delete(dir)) collapsed.add(dir);
      return { collapsed };
    }),
  setCell: (px) => set({ cell: Math.min(CELL_MAX, Math.max(CELL_MIN, Math.round(px))) }),
  resetForNewRoot: (includeSubdirs) => set({ includeSubdirs, dirFilter: null, collapsed: new Set() }),
}));
