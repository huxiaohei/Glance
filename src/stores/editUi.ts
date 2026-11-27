import { create } from "zustand";
import { editClose, editOpen, editParamsGet, editParamsSet, editPick, editPreview, editResultUrl } from "../ipc/api";
import type {
  BatchPlan, CompressMemory, ConvertMemory, CropMemory, CropState, EditOpened, EditParams, EditParamsMemory, EditTab, FileId,
  PreviewResult, RemoveBgMemory,
} from "../ipc/types";
import { createPreviewScheduler } from "../lib/editPreview";
import { noCompress } from "../lib/noCompress";

export interface EditUiState {
  status: "idle" | "opening" | "ready" | "saving";
  id: FileId | null;
  opened: EditOpened | null;
  tab: EditTab;
  compress: CompressMemory;
  crop: CropMemory;
  removeBg: RemoveBgMemory;
  convert: ConvertMemory;
  /** 裁剪页的当前状态（每张图重新开始，不记忆）；未打开时为 null */
  cropState: CropState | null;
  /** 去背景“按颜色”的目标色（每张图重新取左上角像素，不记忆） */
  bgColor: [number, number, number] | null;
  result: PreviewResult | null;
  resultUrl: string | null;
  showOriginal: boolean;
  error: string | null;
  /** 最新一次预览失败的错误码；下一次成功的预览清掉 */
  previewError: string | null;
  /** 保存失败的原因（已翻译）；改参数、换页或再次保存时清掉 */
  saveError: string | null;
  /**
   * 批量模式：选中的图（网格顺序）与按当前页签算出的处理清单（未到时为 null）。不为 null 时处在批量模式：
   * 面板只有压缩、转格式两页，左右键在 ids 里切图。close() 不清它（切图时先关再开），由 batchMode 管理。
   */
  batch: { ids: FileId[]; plan: BatchPlan | null } | null;
  /**
   * 打开一张图的编辑会话。给了 tab 就用它（批量模式、网格里选一张按页签进入），否则按记忆的页签；
   * keepParams 为真时不读记忆，沿用当前参数（批量模式里切图）。
   * 返回这一次打开自己的结果：被关闭或被更新的打开取代时为 superseded（此时 store 里的状态属于别的打开）。
   */
  open(id: FileId, opts?: OpenOpts): Promise<OpenOutcome>;
  close(): void;
  setTab(t: EditTab): void;
  patch<T extends keyof PatchMap>(tab: T, partial: Partial<PatchMap[T]>): void;
  setCropState(next: CropState): void;
  /** 取源图 (x, y) 的颜色作为去背景的目标色，并刷新预览。 */
  pick(x: number, y: number): Promise<void>;
  setShowOriginal(b: boolean): void;
  /** 保存成功后调用：记住这次保存用的页与参数（取消不记）。 */
  commitMemory(): Promise<void>;
}

export interface OpenOpts { tab?: EditTab; keepParams?: boolean }

/** 一次 open() 自己的结果。 */
export type OpenOutcome = { kind: "ready" } | { kind: "superseded" } | { kind: "failed"; error: string };
const READY: OpenOutcome = { kind: "ready" };
const SUPERSEDED: OpenOutcome = { kind: "superseded" };

interface PatchMap { compress: CompressMemory; crop: CropMemory; removeBg: RemoveBgMemory; convert: ConvertMemory }

const DEFAULT_CROP: CropMemory = { ratio: "free", customW: 3, customH: 2, portrait: false };
const DEFAULT_REMOVE_BG: RemoveBgMemory = {
  mode: "color", threshold: 16, below: true, tolerance: 10, softness: 10, edgeConnected: true,
};
const WHITE: [number, number, number] = [255, 255, 255];
const DEFAULT_COMPRESS: CompressMemory = { quality: 80, maxEdgeOn: false, maxEdge: 2048, pngMode: "lossy" };
const DEFAULT_CONVERT: ConvertMemory = { format: "jpeg", quality: 85, fill: [255, 255, 255] };

/** 是否处在编辑模式（含正在打开、正在保存）：命令表据此把单张视图当作 "edit"。 */
export function editActive(): boolean {
  return isEditing(useEditUi.getState());
}

/** 选择器：处在编辑模式（有会话，或在批量模式里——批量模式下这张图打不开时也算）。 */
export function isEditing(s: Pick<EditUiState, "status" | "batch">): boolean {
  return s.status !== "idle" || s.batch !== null;
}

/** 处在批量模式。 */
export function inBatch(): boolean {
  return useEditUi.getState().batch !== null;
}

/** 源格式不支持压缩（GIF / BMP / HEIC / AVIF）且当前在压缩页：不能保存。 */
export function compressUnsupported(s: Pick<EditUiState, "tab" | "opened">): boolean {
  const f = s.opened?.srcFormat;
  return s.tab === "compress" && f !== undefined && noCompress(f);
}

/** 质量夹到后端接受的 1..=100（PNG 目标时滑块禁用，仍须带一个有效值）。 */
const clampQuality = (q: number) => (Number.isFinite(q) ? Math.min(100, Math.max(1, Math.round(q))) : 85);

/** 由当前页与记忆参数拼出发给后端的参数。 */
export function currentParams(
  s: Pick<EditUiState, "tab" | "compress" | "convert" | "crop" | "removeBg" | "cropState" | "bgColor">,
): EditParams {
  if (s.tab === "crop" && s.cropState) {
    const c = s.cropState;
    return { op: "crop", rect: c.rect, quarterTurns: c.quarterTurns, flipH: c.flipH, flipV: c.flipV };
  }
  if (s.tab === "removeBg") {
    const r = s.removeBg;
    if (r.mode === "alpha") return { op: "removeBg", mode: "alpha", threshold: r.threshold, below: r.below };
    return {
      op: "removeBg", mode: "color", color: s.bgColor ?? WHITE,
      tolerance: r.tolerance, softness: r.softness, edgeConnected: r.edgeConnected,
    };
  }
  if (s.tab === "compress") {
    const c = s.compress;
    return { op: "compress", quality: clampQuality(c.quality), maxEdge: c.maxEdgeOn ? c.maxEdge : null, pngMode: c.pngMode };
  }
  const v = s.convert;
  return { op: "convert", format: v.format, quality: clampQuality(v.quality), fill: v.fill };
}

/** 裁剪状态是否等于“没改”：整图、不旋转、不翻转。 */
export function cropIsIdentity(s: CropState, o: Pick<EditOpened, "width" | "height">): boolean {
  const r = s.rect;
  return r.x === 0 && r.y === 0 && r.w === o.width && r.h === o.height && s.quarterTurns === 0 && !s.flipH && !s.flipV;
}

/** 在裁剪页且裁剪状态等于“没改”：不能保存（提示“未做任何修改”）。 */
export function cropUnchanged(s: Pick<EditUiState, "tab" | "opened" | "cropState">): boolean {
  return s.tab === "crop" && s.opened !== null && s.cropState !== null && cropIsIdentity(s.cropState, s.opened);
}

/** 当前不能保存：压缩不支持，或裁剪未做改动。 */
export function saveBlocked(s: Pick<EditUiState, "tab" | "opened" | "cropState">): boolean {
  return compressUnsupported(s) || cropUnchanged(s);
}

const idle = {
  status: "idle" as const,
  id: null,
  opened: null,
  cropState: null,
  bgColor: null,
  result: null,
  resultUrl: null,
  showOriginal: false,
  previewError: null,
  saveError: null,
};

let scheduler: ReturnType<typeof createPreviewScheduler> | null = null;
/** 每次 open / close 加一，用来丢弃过期的 open 应答。 */
let epoch = 0;
/**
 * 记忆里是“按透明度”、但这张图不透明而本次改用“按颜色”时，记下原来的方式：
 * 保存时记忆仍写回它；用户在本次编辑中自己改了方式则清掉。每次 open 重置。
 */
let rememberedBgMode: RemoveBgMemory["mode"] | null = null;

function memoryOf(s: EditUiState): EditParamsMemory {
  const removeBg = rememberedBgMode !== null ? { ...s.removeBg, mode: rememberedBgMode } : s.removeBg;
  return { tab: s.tab, compress: s.compress, crop: s.crop, removeBg, convert: s.convert };
}

/**
 * 参数变了，按需刷新预览。裁剪页上裁剪状态等于“没改”时不发请求（整图裁剪不能保存，
 * 全尺寸编码却要好几秒）：取消待发的请求、丢掉在途与已有的结果，底栏显示原尺寸。
 */
function refresh(get: () => EditUiState, set: (p: Partial<EditUiState>) => void): void {
  if (scheduler === null) return;
  if (cropUnchanged(get())) {
    scheduler.cancel();
    if (get().result !== null || get().resultUrl !== null) set({ result: null, resultUrl: null });
    return;
  }
  scheduler.change();
}

export const useEditUi = create<EditUiState>()((set, get) => ({
  ...idle,
  tab: "compress",
  compress: DEFAULT_COMPRESS,
  crop: DEFAULT_CROP,
  removeBg: DEFAULT_REMOVE_BG,
  convert: DEFAULT_CONVERT,
  error: null,
  batch: null,

  async open(id, opts) {
    get().close();
    const mine = ++epoch;
    const fixedTab = opts?.tab;
    set({ ...idle, status: "opening", id, error: null, ...(fixedTab !== undefined ? { tab: fixedTab } : {}) });
    let memory: EditParamsMemory | null = null;
    if (!opts?.keepParams) {
      try {
        memory = await editParamsGet();
      } catch {
        memory = null;
      }
      if (mine !== epoch) return SUPERSEDED;
    }
    // 页签由调用方定（批量模式）：参数立刻换成记忆，打不开这张图时也能照常调参数
    if (fixedTab !== undefined && memory) {
      set({ compress: memory.compress, crop: memory.crop, removeBg: memory.removeBg, convert: memory.convert });
    }
    let opened: EditOpened;
    try {
      opened = await editOpen(id);
    } catch (e) {
      if (mine !== epoch) return SUPERSEDED;
      const error = typeof e === "string" ? e : "decode";
      set({ ...idle, error });
      return { kind: "failed", error };
    }
    if (mine !== epoch) {
      // 期间被关闭或被新的 open 取代：这个会话没人用了。
      void editClose(opened.session).catch(() => {});
      return SUPERSEDED;
    }
    const unavailable = noCompress(opened.srcFormat);
    const rememberedTab = memory?.tab ?? "compress";
    const session = opened.session;
    let bgColor = WHITE;
    try {
      bgColor = await editPick(session, 0, 0);
    } catch {
      bgColor = WHITE;
    }
    if (mine !== epoch) {
      void editClose(session).catch(() => {});
      return SUPERSEDED;
    }
    const cropState: CropState = {
      rect: { x: 0, y: 0, w: opened.width, h: opened.height }, quarterTurns: 0, flipH: false, flipV: false,
    };
    if (fixedTab !== undefined && get().batch !== null) {
      // 批量模式：页签是整批的操作，在开始时已设好（打开期间用户可能又换过页，以当前为准），不因这一张换页；
      // 参数已在上面换好或沿用当前的
      rememberedBgMode = null;
      set({ status: "ready", opened, cropState, bgColor });
    } else {
      // 普通打开用记忆的页签，网格里给了页签的用给定的；其余调整（GIF / BMP 压缩落到转格式、不透明图强制按颜色）相同
      const wantedTab = fixedTab ?? rememberedTab;
      const removeBg = memory?.removeBg ?? DEFAULT_REMOVE_BG;
      const forceColor = removeBg.mode === "alpha" && !opened.hasAlpha;
      rememberedBgMode = forceColor ? removeBg.mode : null;
      set({
        status: "ready",
        opened,
        tab: unavailable && wantedTab === "compress" ? "convert" : wantedTab,
        compress: memory?.compress ?? DEFAULT_COMPRESS,
        crop: memory?.crop ?? DEFAULT_CROP,
        removeBg: forceColor ? { ...removeBg, mode: "color" } : removeBg,
        convert: memory?.convert ?? DEFAULT_CONVERT,
        cropState,
        bgColor,
      });
    }
    scheduler = createPreviewScheduler({
      proxy: () => get().tab !== "crop",
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
    refresh(get, set);
    return READY;
  },

  close() {
    epoch += 1;
    rememberedBgMode = null;
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
    const prev = get().tab;
    if (prev === tab) return;
    // 进出裁剪页：上一页的结果与新页的尺寸、画面都对不上，丢掉，等新结果（期间显示“计算中”）。
    // 换页一并松开“按住查看原图”（裁剪页没有这个按钮，按下中切过去会卡住）
    const crossCrop = prev === "crop" || tab === "crop";
    // 上一页的预览失败（如 GIF 在压缩页不支持）也一并清掉，不带到新页
    set({
      tab, saveError: null, previewError: null, showOriginal: false,
      ...(crossCrop ? { result: null, resultUrl: null } : {}),
    });
    // 上一页还在途的请求作废：它的结果晚于换页到达也不上画面
    scheduler?.cut();
    refresh(get, set);
  },

  patch(tab, partial) {
    // 各页的记忆各存一份；PatchMap 保证 partial 与 tab 对得上。
    set((s) => ({ [tab]: { ...s[tab], ...partial }, saveError: null }) as Partial<EditUiState>);
    if (tab === "removeBg" && "mode" in partial) rememberedBgMode = null;
    // 裁剪的记忆（比例等）不进参数；框的变化都走 setCropState
    if (tab !== "crop" && get().tab === tab) refresh(get, set);
  },

  setCropState(cropState) {
    set({ cropState, saveError: null });
    if (get().tab === "crop") refresh(get, set);
  },

  async pick(x, y) {
    const session = get().opened?.session;
    if (session === undefined) return;
    let c: [number, number, number];
    try {
      c = await editPick(session, x, y);
    } catch {
      return;
    }
    if (get().opened?.session !== session) return;
    set({ bgColor: c, saveError: null });
    if (get().tab === "removeBg") refresh(get, set);
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
