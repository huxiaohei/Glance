import type { SortKey } from "../lib/deriveList";

export type FileId = number;
export type Tier = 320 | 640;

export interface BasketEntry {
  id: FileId;
  name: string;
  dirName: string;
  size: number;
  mtimeMs: number;
  w: number | null;
  h: number | null;
}
export interface RestoredItem {
  id: FileId;
  name: string;
  dirName: string;
  entry: BasketEntry | null;
}
export interface BrowseEntry { id: FileId; name: string; size: number; mtimeMs: number }
export interface BrowseResult { name: string; entries: BrowseEntry[] }
export interface WireEntry { id: FileId; relPath: string; size: number; mtimeMs: number }

export type CatalogEvent =
  | { type: "batch"; generation: number; entries: WireEntry[] }
  | { type: "done"; generation: number; total: number }
  | { type: "dims"; generation: number; items: { id: FileId; w: number; h: number }[] }
  | { type: "removed"; generation: number; ids: FileId[] }
  | { type: "renamed"; generation: number; items: { id: FileId; relPath: string }[] }
  | { type: "watchFailed"; generation: number }
  | { type: "rootGone"; generation: number };

export interface RootInfo { generation: number; path: string; name: string; recursive: boolean; focus: FileId | null }

export type OpenErrorCode = "notFound" | "notAnImage" | "unreadable";

// noCodec：本机系统没有这种格式（HEIC / AVIF）的解码器。
export type ThumbEvent =
  | { type: "ready"; id: FileId; tier: Tier; v: string }
  | { type: "broken"; id: FileId }
  | { type: "noCodec"; id: FileId };

export interface ExifItem {
  key: "make" | "model" | "lens" | "dateTime" | "exposure" | "fNumber" | "iso" | "focalLength";
  value: string;
}

/** 图片详情。path 只用于显示（“前端只见 FileId”的明确例外），不得拿它访问文件。 */
export interface ImageDetails {
  path: string;
  mtimeMs: number;
  color: "RGB" | "RGBA" | "Gray" | "GrayA" | "Indexed" | null;
  bitDepth: number | null;
  hasAlpha: boolean | null;
  dpi: [number, number] | null;
  animated: boolean;
  exif: ExifItem[];
}

export type FsErrorCode = "notFound" | "exists" | "invalidName" | "readOnly" | "diskFull" | "denied"
  | "restoreDenied" | "notInTrash" | "tooLarge" | "other";
export type OpKind = "trash" | "rename" | "move" | "copy" | "edit" | "batch";
/** 文件操作的结果。dest 是移动 / 复制的目标目录，只用于显示。 */
export interface OpReport { kind: OpKind; done: FileId[]; failed: { id: FileId; code: FsErrorCode }[]; token: number | null; dest: string | null }
export type Dest =
  | { kind: "path"; path: string }
  | { kind: "newChild"; name: string }
  | { kind: "dir"; dir: string };
export type Conflict = "skip" | "keepBoth";
/** 撤销失败的一步：name 只是文件名（最后一级），不是路径 */
export interface UndoFailure { name: string; code: FsErrorCode }
export interface UndoReport { kind: OpKind | null; done: number; failed: UndoFailure[] }

export type Theme = "dark" | "light" | "system";
export type Language = "system" | "zh-CN" | "en";
export type WheelAction = "zoom" | "switch";
export type CompareBackground = "dark" | "light" | "checker";

export interface Settings {
  theme: Theme;
  language: Language;
  includeSubdirs: boolean;
  defaultSort: SortKey;
  loopAtEnd: boolean;
  wheel: WheelAction;
  checkUpdates: boolean;
  /** 对比视图每排张数，2 到 8 */
  compareColumns: number;
  compareSyncOnEnter: boolean;
  compareBackground: CompareBackground;
  /** 底部按当前状态给出的快捷键提示 */
  showKeyHints: boolean;
  /** 编辑面板的默认保存方式 */
  editSaveMode: "copy" | "overwrite";
  /** 批量压缩 / 转格式的输出子目录名 */
  batchOutputDir: string;
}

/** 最近目录的一项。path 只用于显示和原样传回 open_path / recents_pin / recents_remove（“前端只见 FileId”的明确例外）。
 *  thumbs 是缩略图缓存键，用 thumbKeyUrl 拼地址；count、sort、includeSubdirs 在从未汇报过时为 null。 */
export interface RecentEntry {
  path: string;
  name: string;
  count: number | null;
  thumbs: string[];
  pinned: boolean;
  exists: boolean;
  sort: SortKey | null;
  includeSubdirs: boolean | null;
}

/** 拖出窗口的系统拖拽结束结果。 */
export type DragEnd = "dropped" | "cancelled";

// ---- 编辑（压缩与转格式）----
export type SrcFormat = "png" | "jpeg" | "webp" | "gif" | "bmp";
export type OutFormat = "png" | "jpeg" | "webp";
export type PngMode = "lossy" | "lossless";
export type EditTab = "compress" | "crop" | "removeBg" | "convert";
export type EditError = "notFound" | "animated" | "tooLarge" | "decode" | "unsupported" | "noSession" | "encode" | "invalid";
export type EditParams =
  | { op: "compress"; quality: number; maxEdge: number | null; pngMode: PngMode }
  | { op: "convert"; format: OutFormat; quality: number; fill: [number, number, number] }
  | { op: "crop"; rect: CropRect; quarterTurns: 0 | 1 | 2 | 3; flipH: boolean; flipV: boolean }
  | { op: "removeBg"; mode: "alpha"; threshold: number; below: boolean }
  | { op: "removeBg"; mode: "color"; color: [number, number, number]; tolerance: number; softness: number; edgeConnected: boolean };
export interface CropRect { x: number; y: number; w: number; h: number }
export interface CropState { rect: CropRect; quarterTurns: 0 | 1 | 2 | 3; flipH: boolean; flipV: boolean }
export interface EditOpened {
  session: number; width: number; height: number; proxyW: number; proxyH: number;
  srcFormat: SrcFormat; hasAlpha: boolean; fileSize: number;
}
export interface PreviewResult { rev: number; bytes: number; approx: boolean; format: OutFormat; width: number; height: number }
export type SaveMode = { kind: "copy" } | { kind: "overwrite" } | { kind: "saveAs"; path: string };
export interface SaveReport { id: FileId; name: string; bytes: number; token: number | null; outside: boolean }
export interface CompressMemory { quality: number; maxEdgeOn: boolean; maxEdge: number; pngMode: PngMode }
export interface ConvertMemory { format: OutFormat; quality: number; fill: [number, number, number] }
export type CropRatio = "free" | "1:1" | "4:3" | "16:9" | "custom";
export interface CropMemory { ratio: CropRatio; customW: number; customH: number; portrait: boolean }
export interface RemoveBgMemory {
  mode: "alpha" | "color"; threshold: number; below: boolean; tolerance: number; softness: number; edgeConnected: boolean;
}
export interface EditParamsMemory {
  tab: EditTab; compress: CompressMemory; crop: CropMemory; removeBg: RemoveBgMemory; convert: ConvertMemory;
}

export type BatchOp = "compress" | "convert";
export type SkipReason = "unsupported" | "animated" | "inOutput" | "notFound";

export interface SkipItem {
  id: FileId;
  name: string;
  reason: SkipReason;
}

export interface BatchPlan {
  process: FileId[];
  skipped: SkipItem[];
}

export type FailReason = "notFound" | "decode" | "tooLarge" | "encode" | "readOnly" | "diskFull" | "denied" | "other";

export interface Failure {
  id: FileId;
  name: string;
  reason: FailReason;
}

export interface BatchSummary {
  /** 成功产出的张数 */
  processed: number;
  failed: Failure[];
  skipped: SkipItem[];
  /** 成功各张的原大小减产出大小之和，可为负 */
  savedBytes: number;
  /** 撤销用；没有产出时为 null */
  token: number | null;
  cancelled: boolean;
}

/** 批量任务经 Channel 推来的事件：节流的进度（done = 成功 + 失败），最后一次进度之后是 finished。 */
export type BatchEvent =
  | { kind: "progress"; done: number; total: number; failed: number; savedBytes: number }
  | ({ kind: "finished" } & BatchSummary);

export type BatchError = "busy" | "invalid" | "noRoot";
