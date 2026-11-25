import { create } from "zustand";
import { editClose, editOpen, editParamsGet, editParamsSet, editPreview, editResultUrl } from "../ipc/api";
import type {
  CompressMemory, ConvertMemory, EditOpened, EditParams, EditParamsMemory, EditTab, FileId, PreviewResult,
} from "../ipc/types";
import { createPreviewScheduler } from "../lib/editPreview";

export interface EditUiState {
  status: "idle" | "opening" | "ready" | "saving";
  id: FileId | null;
  opened: EditOpened | null;
  tab: EditTab;
  compress: CompressMemory;
  convert: ConvertMemory;
  result: PreviewResult | null;
  resultUrl: string | null;
  showOriginal: boolean;
  error: string | null;
  /** 最新一次预览失败的错误码；下一次成功的预览清掉 */
  previewError: string | null;
  /** 保存失败的原因（已翻译）；改参数、换页或再次保存时清掉 */
  saveError: string | null;
  open(id: FileId): Promise<void>;
  close(): void;
  setTab(t: EditTab): void;
  patch<T extends EditTab>(tab: T, partial: Partial<T extends "compress" ? CompressMemory : ConvertMemory>): void;
  setShowOriginal(b: boolean): void;
  /** 保存成功后调用：记住这次保存用的页与参数（取消不记）。 */
  commitMemory(): Promise<void>;
}

const DEFAULT_COMPRESS: CompressMemory = { quality: 80, maxEdgeOn: false, maxEdge: 2048, pngMode: "lossy" };
const DEFAULT_CONVERT: ConvertMemory = { format: "jpeg", quality: 85, fill: [255, 255, 255] };

/** 是否处在编辑模式（含正在打开、正在保存）：命令表据此把单张视图当作 "edit"。 */
export function editActive(): boolean {
  return useEditUi.getState().status !== "idle";
}

/** 源格式不支持压缩（GIF / BMP）且当前在压缩页：不能保存。 */
export function compressUnsupported(s: Pick<EditUiState, "tab" | "opened">): boolean {
  const f = s.opened?.srcFormat;
  return s.tab === "compress" && (f === "gif" || f === "bmp");
}

/** 质量夹到后端接受的 1..=100（PNG 目标时滑块禁用，仍须带一个有效值）。 */
const clampQuality = (q: number) => (Number.isFinite(q) ? Math.min(100, Math.max(1, Math.round(q))) : 85);

/** 由当前页与记忆参数拼出发给后端的参数。 */
export function currentParams(s: Pick<EditUiState, "tab" | "compress" | "convert">): EditParams {
  if (s.tab === "compress") {
    const c = s.compress;
    return { op: "compress", quality: clampQuality(c.quality), maxEdge: c.maxEdgeOn ? c.maxEdge : null, pngMode: c.pngMode };
  }
  const v = s.convert;
  return { op: "convert", format: v.format, quality: clampQuality(v.quality), fill: v.fill };
}

const idle = {
  status: "idle" as const,
  id: null,
  opened: null,
  result: null,
  resultUrl: null,
  showOriginal: false,
  previewError: null,
  saveError: null,
};

let scheduler: ReturnType<typeof createPreviewScheduler> | null = null;
/** 每次 open / close 加一，用来丢弃过期的 open 应答。 */
let epoch = 0;

function memoryOf(s: EditUiState): EditParamsMemory {
  return { tab: s.tab, compress: s.compress, convert: s.convert };
}

export const useEditUi = create<EditUiState>()((set, get) => ({
  ...idle,
  tab: "compress",
  compress: DEFAULT_COMPRESS,
  convert: DEFAULT_CONVERT,
  error: null,

  async open(id) {
    get().close();
    const mine = ++epoch;
    set({ ...idle, status: "opening", id, error: null });
    let memory: EditParamsMemory | null = null;
    try {
      memory = await editParamsGet();
    } catch {
      memory = null;
    }
    if (mine !== epoch) return;
    let opened: EditOpened;
    try {
      opened = await editOpen(id);
    } catch (e) {
      if (mine !== epoch) return;
      set({ ...idle, error: typeof e === "string" ? e : "decode" });
      return;
    }
    if (mine !== epoch) {
      // 期间被关闭或被新的 open 取代：这个会话没人用了。
      void editClose(opened.session).catch(() => {});
      return;
    }
    const unavailable = opened.srcFormat === "gif" || opened.srcFormat === "bmp";
    const rememberedTab = memory?.tab ?? "compress";
    const session = opened.session;
    set({
      status: "ready",
      opened,
      tab: unavailable && rememberedTab === "compress" ? "convert" : rememberedTab,
      compress: memory?.compress ?? DEFAULT_COMPRESS,
      convert: memory?.convert ?? DEFAULT_CONVERT,
    });
    scheduler = createPreviewScheduler({
      run: (rev, full) => editPreview(session, rev, currentParams(get()), full),
      onResult: (r) => {
        if (get().opened?.session !== session) return;
        set({ result: r, resultUrl: editResultUrl(session, r.rev), previewError: null });
      },
      onError: (err) => {
        if (get().opened?.session !== session) return;
        set({ previewError: typeof err === "string" ? err : "encode" });
      },
    });
    scheduler.change();
  },

  close() {
    epoch += 1;
    scheduler?.dispose();
    scheduler = null;
    const s = get();
    const session = s.opened?.session;
    if (session !== undefined) {
      void editClose(session).catch(() => {});
    }
    set({ ...idle, error: null });
  },

  setTab(tab) {
    if (get().tab === tab) return;
    set({ tab, saveError: null });
    scheduler?.change();
  },

  patch(tab, partial) {
    if (tab === "compress") set((s) => ({ compress: { ...s.compress, ...partial }, saveError: null }));
    else set((s) => ({ convert: { ...s.convert, ...partial }, saveError: null }));
    if (get().tab === tab) scheduler?.change();
  },

  setShowOriginal(showOriginal) {
    set({ showOriginal });
  },

  async commitMemory() {
    try {
      await editParamsSet(memoryOf(get()));
    } catch {
      // 记不住不影响保存本身
    }
  },
}));
