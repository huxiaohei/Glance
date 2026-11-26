import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { glanceUrl } from "../lib/glanceUrl";
import type { SortKey } from "../lib/deriveList";
import type {
  EditOpened,
  EditParams,
  EditParamsMemory,
  PreviewResult,
  SaveMode,
  SaveReport,
  CatalogEvent,
  Conflict,
  Dest,
  DragEnd,
  FileId,
  BasketEntry,
  BatchEvent,
  BatchOp,
  BatchPlan,
  BrowseResult,
  RestoredItem,
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

export function basketCheck(ids: FileId[]): Promise<(BasketEntry | null)[]> {
  return invoke<(BasketEntry | null)[]>("basket_check", { ids });
}

export function batchPlan(ids: FileId[], op: BatchOp): Promise<BatchPlan> {
  return invoke<BatchPlan>("batch_plan", { ids, op });
}

/** 开始批量压缩 / 转格式，返回任务号；失败时以 BatchError 拒绝。 */
export function batchStart(ids: FileId[], params: EditParams, onEvent: (e: BatchEvent) => void): Promise<number> {
  return invoke<number>("batch_start", { ids, params, onEvent: channel(onEvent) });
}

export function batchCancel(job: number): Promise<void> {
  return invoke<void>("batch_cancel", { job });
}

export function basketSave(ids: FileId[]): Promise<void> {
  return invoke<void>("basket_save", { ids });
}

export function browseDir(path: string): Promise<BrowseResult> {
  return invoke<BrowseResult>("browse_dir", { path });
}

export function basketRestore(): Promise<RestoredItem[]> {
  return invoke<RestoredItem[]>("basket_restore");
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

/** 检查新版本：有则返回版本号，没有、关闭了或调试构建返回 null（是否检查由后端判断）。 */
export function updateCheck(): Promise<string | null> {
  return invoke<string | null>("update_check");
}

/** 下载并安装待更新的版本，成功后应用重启；失败时拒绝（`updateFailed`），再调一次可重试。 */
export function updateInstall(): Promise<void> {
  return invoke<void>("update_install");
}

/** 当前应用版本号。 */
export function appVersion(): Promise<string> {
  return getVersion();
}

/** 打开编辑会话；动图等不可编辑的拒绝为 EditError 字符串。 */
export function editOpen(id: FileId): Promise<EditOpened> {
  return invoke<EditOpened>("edit_open", { id });
}

/** 请求一次预览；被更新的请求取代或会话已关时为 null。 */
export function editPreview(session: number, rev: number, params: EditParams, full: boolean): Promise<PreviewResult | null> {
  return invoke<PreviewResult | null>("edit_preview", { session, rev, params, full });
}

export function editClose(session: number): Promise<void> {
  return invoke<void>("edit_close", { session });
}

/** 保存编辑结果；另存的路径来自系统存储对话框，原样传入。 */
export function editSave(session: number, params: EditParams, mode: SaveMode): Promise<SaveReport> {
  return invoke<SaveReport>("edit_save", { session, params, mode });
}

export function editParamsGet(): Promise<EditParamsMemory> {
  return invoke<EditParamsMemory>("edit_params_get");
}

export function editParamsSet(p: EditParamsMemory): Promise<void> {
  return invoke<void>("edit_params_set", { p });
}

/** 预览结果的图片地址（只含会话号与版本号）。 */
export function editResultUrl(session: number, rev: number): string {
  return glanceUrl(`edit/${session}/${rev}`);
}

/** 取源图（转正后）一个像素的颜色；越界为 "invalid"。 */
export function editPick(session: number, x: number, y: number): Promise<[number, number, number]> {
  return invoke<[number, number, number]>("edit_pick", { session, x, y });
}

/** 裁剪页显示的转正源图地址。 */
export function editSourceUrl(session: number): string {
  return glanceUrl(`edit/${session}/source`);
}
