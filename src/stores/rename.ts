import { create, type StoreApi, type UseBoundStore } from "zustand";
import { getImageList } from "../app/useImageList";
import type { FileId } from "../ipc/types";
import { useCatalog } from "./catalog";
import { useGridCtx } from "./gridCtx";
import { topView, useNav } from "./nav";
import { useSelection } from "./selection";

/** 正在原地重命名的那张图；null 表示没有在重命名。 */
export const useRename: UseBoundStore<StoreApi<{ id: FileId | null }>> = create<{ id: FileId | null }>(() => ({ id: null }));

/** 开始重命名：单张视图 → 当前图；网格 → 焦点所在且可见的那张（没有则不做事）。给了 id 则直接用它。 */
export function startRename(id?: FileId): void {
  if (id !== undefined) {
    useRename.setState({ id });
    return;
  }
  if (!useCatalog.getState().root) return;
  const top = topView();
  if (top.kind === "single") {
    useRename.setState({ id: top.id });
    return;
  }
  const focus = useSelection.getState().focus;
  if (focus === null || !getImageList().ids.includes(focus)) return;
  useGridCtx.getState().reveal(focus);
  useRename.setState({ id: focus });
}

export function stopRename(): void {
  if (useRename.getState().id !== null) useRename.setState({ id: null });
}

// 那张图被移除或换了目录时退出编辑
useCatalog.subscribe((state, prev) => {
  const id = useRename.getState().id;
  if (id === null) return;
  if (state.root?.path !== prev.root?.path || !state.entries.has(id)) stopRename();
});

// 进出单张视图、单张视图换图时退出编辑
useNav.subscribe((state, prev) => {
  if (state.stack !== prev.stack) stopRename();
});
