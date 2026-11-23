import { create } from "zustand";

interface SingleUiState {
  infoOpen: boolean;
  toggleInfo(): void;
}

/** 单张视图的界面状态，一次应用运行内保持（离开再进入仍是上次的样子）。 */
export const useSingleUi = create<SingleUiState>((set) => ({
  infoOpen: false,
  toggleInfo: () => set((s) => ({ infoOpen: !s.infoOpen })),
}));
