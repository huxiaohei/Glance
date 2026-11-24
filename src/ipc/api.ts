import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SortKey } from "../lib/deriveList";
import type {
  CatalogEvent,
  Conflict,
  Dest,
  DragEnd,
  FileId,
  ImageDetails,
  OpReport,
  RecentEntry,
  RootInfo,
  Settings,
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
  restore: boolean,
  onEvent: (e: CatalogEvent) => void,
): Promise<RootInfo> {
  return invoke<RootInfo>("open_path", { path, recursive, seq, restore, onEvent: channel(onEvent) });
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

/** 后端失败时以错误码字符串（如 "tooLarge"）拒绝。 */
export function clipboardCopyImage(id: FileId): Promise<void> {
  return invoke<void>("clipboard_copy_image", { id });
}

export function clipboardCopyPaths(ids: FileId[]): Promise<void> {
  return invoke<void>("clipboard_copy_paths", { ids });
}

/** 把这些文件拖出窗口，交给系统拖拽，结束时调用 onEnd。macOS 上拖拽发起后就兑现；
 *  Windows 上要到松手后才兑现，可能晚于 onEnd —— 不要依赖两者的先后。
 *  失败时以错误码字符串（如 "notFound"）拒绝。 */
export function dragOut(ids: FileId[], onEnd: (r: DragEnd) => void): Promise<void> {
  return invoke<void>("drag_out", { ids, onEnd: channel(onEnd) });
}

export function reveal(id: FileId): Promise<void> {
  return invoke<void>("reveal", { id });
}

export function settingsGet(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

export function settingsSet(settings: Settings): Promise<void> {
  return invoke<void>("settings_set", { settings });
}

export function recentsList(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_list");
}

export function recentsPin(path: string, pinned: boolean): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_pin", { path, pinned });
}

export function recentsRemove(path: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_remove", { path });
}

/** 汇报当前根目录的浏览状态；generation 与后端当前会话不符时后端忽略。 */
export function recentsNote(note: {
  generation: number;
  count: number;
  first: FileId[];
  last: FileId | null;
  sort: SortKey;
  includeSubdirs: boolean;
}): Promise<void> {
  return invoke<void>("recents_note", note);
}

/** 取走并清除最近一条待处理的打开请求（路径）；没有则为 null。 */
export function takeOpenRequest(): Promise<string | null> {
  return invoke<string | null>("take_open_request");
}

/** 后端记下新的打开请求时触发（无内容）；返回取消监听的函数。 */
export function onOpenRequest(handler: () => void): Promise<() => void> {
  return listen("open_request", () => handler());
}
