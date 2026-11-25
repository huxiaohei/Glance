import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileId } from "../ipc/types";
import { FIT_VIEWPORT, type CompareViewport } from "../lib/compareViewport";
import { dirExists, type PanelSource } from "../lib/panelSource";
import { useCatalog } from "./catalog";

/** 最近一次用对话框选的其他文件夹：留在来源下拉里，再选回时按 path 重新扫描。path 只用于传回 browse_dir。 */
export interface OtherDir { path: string; name: string; count: number }

/**
 * 对比视图的界面状态（不存设置）。perCell 为 null 表示同步缩放开：所有格共用 viewport；
 * 否则每格各自的视口存在 perCell 里，没有的格取 viewport。
 * “每次进入”由 CompareView 挂载时调 enter 实现：对比视图在其上压着对比篮来源的单张视图时只隐藏不卸载，
 * 从单张返回不算新的进入，视口、焦点原样保留。
 */
export interface CompareUiState {
  viewport: CompareViewport;
  perCell: Map<FileId, CompareViewport> | null;
  focus: FileId | null;
  /** 说明文字是否显示：本次运行内记住，进入时不重置 */
  captions: boolean;
  /** 添加面板是否打开：本次运行内记住，进入时不重置 */
  panelOpen: boolean;
  /** 添加面板的来源；根目录换了或所选子目录已不在时回到 root */
  panelSource: PanelSource;
  otherDir: OtherDir | null;
  /** 一次新的进入：视口回到适应，同步按 sync，焦点落在 first */
  enter(sync: boolean, first: FileId | null): void;
  setFocus(id: FileId | null): void;
  toggleCaptions(): void;
  /** 开 → 关：各格从当前共享视口出发；关 → 开：共享视口取焦点格自己的（没有则不变） */
  toggleSync(): void;
  togglePanel(): void;
  setPanelSource(s: PanelSource): void;
  setOtherDir(d: OtherDir | null): void;
  /** 交互结束时把热路径上的视口写回 */
  commit(viewport: CompareViewport, perCell: Map<FileId, CompareViewport> | null): void;
  /** 改一格的视口：同步开时改共享视口，否则只改 id 这一格（没有自己的则从共享视口出发） */
  updateViewport(id: FileId, fn: (vp: CompareViewport) => CompareViewport): void;
}

export const useCompareUi: UseBoundStore<StoreApi<CompareUiState>> = create<CompareUiState>((set) => ({
  viewport: FIT_VIEWPORT,
  perCell: null,
  focus: null,
  captions: true,
  panelOpen: false,
  panelSource: { kind: "root" },
  otherDir: null,
  enter: (sync, first) => set({ viewport: FIT_VIEWPORT, perCell: sync ? null : new Map(), focus: first }),
  setFocus: (id) => set((s) => (s.focus === id ? s : { focus: id })),
  toggleCaptions: () => set((s) => ({ captions: !s.captions })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelSource: (panelSource) => set({ panelSource }),
  setOtherDir: (otherDir) => set({ otherDir }),
  toggleSync: () =>
    set((s) => {
      if (s.perCell === null) return { perCell: new Map() };
      const own = s.focus === null ? undefined : s.perCell.get(s.focus);
      return { perCell: null, viewport: own ?? s.viewport };
    }),
  commit: (viewport, perCell) =>
    set((s) => (s.viewport === viewport && s.perCell === perCell ? s : { viewport, perCell })),
  updateViewport: (id, fn) =>
    set((s) => {
      if (s.perCell === null) {
        const viewport = fn(s.viewport);
        return viewport === s.viewport ? s : { viewport };
      }
      const old = viewportOf(s, id);
      const next = fn(old);
      return next === old ? s : { perCell: new Map(s.perCell).set(id, next) };
    }),
}));

/** 某一格当前使用的视口。 */
export function viewportOf(s: Pick<CompareUiState, "viewport" | "perCell">, id: FileId): CompareViewport {
  return s.perCell?.get(id) ?? s.viewport;
}

// 子目录来源是相对根目录的：换了根目录就回到“当前文件夹”；同一根目录里那个目录的图都没了（扫描中不判）也回去
useCatalog.subscribe((state, prev) => {
  const src = useCompareUi.getState().panelSource;
  if (src.kind !== "dir") return;
  const rootChanged = state.root?.path !== prev.root?.path;
  if (!rootChanged && (state.scanning || (state.listVersion === prev.listVersion && !prev.scanning))) return;
  if (rootChanged || !dirExists(state.entries, src.dir)) useCompareUi.getState().setPanelSource({ kind: "root" });
});
