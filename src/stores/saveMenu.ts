import { create } from "zustand";

/** 编辑面板“保存”旁的下拉菜单是否展开。单独成模块：Esc 命令先收起它，不必引入编辑面板。 */
export const useSaveMenu = create<{ open: boolean }>(() => ({ open: false }));

export function isSaveMenuOpen(): boolean {
  return useSaveMenu.getState().open;
}

export function setSaveMenuOpen(open: boolean): void {
  if (useSaveMenu.getState().open !== open) useSaveMenu.setState({ open });
}
