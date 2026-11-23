import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  CatalogEvent,
  Conflict,
  Dest,
  FileId,
  ImageDetails,
  OpReport,
  RootInfo,
  ThumbEvent,
  Tier,
  UndoReport,
} from "./types";

function channel<T>(onEvent: (e: T) => void): Channel<T> {
  const ch = new Channel<T>();
  ch.onmessage = onEvent;
  return ch;
}

export function openPath(
  path: string,
  recursive: boolean,
  seq: number,
  onEvent: (e: CatalogEvent) => void,
): Promise<RootInfo> {
  return invoke<RootInfo>("open_path", { path, recursive, seq, onEvent: channel(onEvent) });
}

export function thumbsSubscribe(onEvent: (e: ThumbEvent) => void): Promise<void> {
  return invoke<void>("thumbs_subscribe", { onEvent: channel(onEvent) });
}

export function thumbsWant(consumer: string, ids: FileId[], tier: Tier): Promise<{ id: FileId; v: string }[]> {
  return invoke<{ id: FileId; v: string }[]>("thumbs_want", { consumer, ids, tier });
}

export function imageDetails(id: FileId): Promise<ImageDetails> {
  return invoke<ImageDetails>("image_details", { id });
}

export function fsTrash(ids: FileId[]): Promise<OpReport> {
  return invoke<OpReport>("fs_trash", { ids });
}

export function fsRename(id: FileId, name: string): Promise<OpReport> {
  return invoke<OpReport>("fs_rename", { id, name });
}

export function fsMove(ids: FileId[], dest: Dest, conflict: Conflict, extend?: number): Promise<OpReport> {
  return invoke<OpReport>("fs_move", { ids, dest, conflict, extend: extend ?? null });
}

export function fsCopy(ids: FileId[], dest: Dest, conflict: Conflict, extend?: number): Promise<OpReport> {
  return invoke<OpReport>("fs_copy", { ids, dest, conflict, extend: extend ?? null });
}

export function fsUndo(): Promise<UndoReport> {
  return invoke<UndoReport>("fs_undo");
}

export function fsRecentTargets(): Promise<string[]> {
  return invoke<string[]>("fs_recent_targets");
}
