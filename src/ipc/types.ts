export type FileId = number;
export type Tier = 320 | 640;

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
export type Dest = { kind: "path"; path: string } | { kind: "newChild"; name: string };
export type Conflict = "skip" | "keepBoth";
export interface UndoReport { kind: OpKind | null; done: number; failed: FsErrorCode[] }
