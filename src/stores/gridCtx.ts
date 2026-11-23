import { create } from "zustand";
import type { FileId } from "../ipc/types";
import type { ImageList } from "../lib/deriveList";
import type { GridLayout } from "../lib/gridLayout";

export interface GridCtx {
  list: ImageList;
  layout: GridLayout;
  reveal: (id: FileId) => void;       // 把这张图滚入可见范围
}

export const EMPTY_GRID_CTX: GridCtx = {
  list: { ids: [], groups: [] },
  layout: { columns: 1, rows: [], totalHeight: 0 },
  reveal: () => {},
};

/** GridView 每次 list 或 layout 变化时写入，供命令与指针处理读取。 */
export const useGridCtx = create<GridCtx>(() => EMPTY_GRID_CTX);
