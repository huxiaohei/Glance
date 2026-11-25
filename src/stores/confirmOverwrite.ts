import { create } from "zustand";

/** 编辑面板的覆盖确认是否打开（全应用唯一的确认弹窗）。单独成模块：键盘处理只需读它，不必引入编辑面板。 */
export const useConfirmOverwrite = create<{ open: boolean }>(() => ({ open: false }));

export function isConfirmOverwriteOpen(): boolean {
  return useConfirmOverwrite.getState().open;
}

export function closeConfirmOverwrite(): void {
  if (useConfirmOverwrite.getState().open) useConfirmOverwrite.setState({ open: false });
}
