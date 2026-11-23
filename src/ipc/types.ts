export type FileId = number;
export type Tier = 320 | 640;

export interface WireEntry { id: FileId; relPath: string; size: number; mtimeMs: number }

export type CatalogEvent =
  | { type: "batch"; generation: number; entries: WireEntry[] }
  | { type: "done"; generation: number; total: number }
  | { type: "dims"; generation: number; items: { id: FileId; w: number; h: number }[] }
  | { type: "removed"; generation: number; ids: FileId[] }
  | { type: "renamed"; generation: number; items: { id: FileId; relPath: string }[] }
  | { type: "watchFailed"; generation: number };

export interface RootInfo { generation: number; path: string; name: string; recursive: boolean; focus: FileId | null }

export type OpenErrorCode = "notFound" | "notAnImage" | "unreadable";

export type ThumbEvent = { type: "ready"; id: FileId; tier: Tier; v: string } | { type: "broken"; id: FileId };
