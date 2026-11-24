import { create } from "zustand";

/** 打赏面板是否打开。 */
export const useTip = create<{ open: boolean }>(() => ({ open: false }));
