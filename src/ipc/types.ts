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

export type ThumbEvent = { type: "ready"; id: FileId; tier: Tier; v: string } | { type: "broken"; id: FileId };

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
export type OpKind = "trash" | "rename" | "move" | "copy";
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
