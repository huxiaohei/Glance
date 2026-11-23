import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, thumbsSubscribe } from "../ipc/api";
import type { OpenErrorCode, RecentEntry } from "../ipc/types";
import type { SortKey } from "../lib/deriveList";
import { changedIds, useCatalog } from "../stores/catalog";
import { createThumbBatcher } from "../stores/thumbBatcher";
import { useListView } from "../stores/listView";
import { loadRecents } from "../stores/recents";
import { useSettings } from "../stores/settings";
import { useThumbs } from "../stores/thumbs";
import { showToast } from "../stores/toast";
import { t } from "../i18n";
import { createOpener, type OpenResult } from "./openSession";
import { flushRecents } from "./recentsSync";

/**
 * keepView：刷新同一目录；sort：新目录开始时就采用的排序（打开最近目录时恢复）；
 * restore：从最近目录打开（网格据此只选中定位上次看到的图片，不进入单张视图）。
 */
const opener = createOpener<{ keepView?: boolean; sort?: SortKey; restore?: boolean }>({
  openPath,
  begin: (info, tag) => {
    if (tag?.keepView) {
      // 刷新：保留视图状态、条目和缩略图；版本变化会让缩略图自行更新。
      // 损坏标记全部清除，读不出的重试一次（扫描结束时被移除的也随之清掉）。
      // 显示名沿用原来的：刷新按规范路径重新打开，经符号链接打开的目录名会变
      useThumbs.getState().clearBroken();
      const prev = useCatalog.getState().root;
      useCatalog.getState().begin(prev ? { ...info, name: prev.name } : info, { keep: true });
      return;
    }
    useThumbs.getState().reset();
    useListView.getState().resetForNewRoot(info.recursive);
    // 在条目到达之前定下排序，网格不会先按旧排序显示、定位后再重排
    if (tag?.sort) useListView.getState().setSort(tag.sort);
    useCatalog.getState().begin(info, { restored: tag?.restore === true });
  },
  apply: (e) => {
    // 内容变了的文件、被删除的文件：先清掉损坏标记，缩略图才会重新请求
    if (e.type === "batch") useThumbs.getState().forget(changedIds(useCatalog.getState().entries, e.entries));
    else if (e.type === "removed") useThumbs.getState().forget(e.ids);
    useCatalog.getState().apply(e);
  },
});

interface OpenOpts { keepView?: boolean; restore?: boolean }

// 打开按调用顺序排队，直到各自真正调用 opener（opener 在调用时同步取序号）：
// 等待汇报送达的打开不会被随后无需等待的打开（包括刷新）抢先。队列从不拒绝。
let queue: Promise<void> = Promise.resolve();

/** 换目录前等待汇报送达的上限：后端迟迟不答也照常打开（这次汇报可能因代号已变被丢弃）。 */
const FLUSH_WAIT_MS = 500;

/** 送出待发的汇报，最多等 FLUSH_WAIT_MS；flushRecents 抛错或拒绝都当作已完成。从不拒绝。 */
function flushBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => { timer = setTimeout(r, FLUSH_WAIT_MS); });
  const flushed = Promise.resolve().then(flushRecents).catch(() => {});
  return Promise.race([flushed, timeout]).finally(() => clearTimeout(timer));
}

async function openWith(
  path: string,
  recursive: boolean | undefined,
  opts?: OpenOpts & { sort?: SortKey },
): Promise<OpenResult> {
  const rec = recursive ?? useSettings.getState().settings.includeSubdirs;
  const keepView = opts?.keepView === true;
  // 换目录之前先把当前目录待发的浏览状态送达后端（新会话开始后，带旧代号的汇报会被丢弃）；刷新同一目录不用
  const turn = queue.then(() => (keepView ? undefined : flushBounded()));
  // 队列只接在“不拒绝”的版本上：某一轮出错也不会让之后的打开全部失败
  queue = turn.catch(() => {});
  try {
    await turn.catch(() => {});
    const restore = !keepView && opts?.restore === true;
    const tag = keepView ? { keepView } : { sort: opts?.sort, restore };
    const result = await opener(path, rec, tag, restore);
    // 打开失败统一在这里用提示条告知；被取代的打开不提示
    if (!result.superseded && result.error) showToast({ text: t(`error.${result.error}`) });
    return result;
  } finally {
    // 打开成功后后端把根目录记入最近目录；成败都重新读取一次
    void loadRecents();
  }
}

/**
 * 打开目录或图片：begin → 事件流写入 catalog；失败时返回错误码。recursive 省略时按设置里的“包含子目录”。
 * restore：恢复最近目录里记下的上次看到的图片（刷新 keepView 时不带）。
 */
export async function openFolder(path: string, recursive?: boolean, opts?: OpenOpts): Promise<OpenErrorCode | null> {
  return (await openWith(path, recursive, opts)).error;
}

/** 打开一项最近目录：恢复上次看到的图片，并按该项记下的“包含子目录”与排序打开（没记的按设置）。 */
export async function openRecent(entry: RecentEntry): Promise<void> {
  // 排序在 begin 里设置：失败或被取代的打开不会 begin，也就不改排序
  await openWith(entry.path, entry.includeSubdirs ?? undefined, { restore: true, sort: entry.sort ?? undefined });
}

/** 刷新当前目录：视图状态与已有条目保留，扫描结束后移除已不存在的文件；没有打开目录时什么也不做。 */
export async function refreshFolder(): Promise<void> {
  const root = useCatalog.getState().root;
  if (!root) return;
  await openFolder(root.path, root.recursive, { keepView: true });
}

/** 弹出系统目录选择框；取消返回 false。 */
export async function pickAndOpenFolder(): Promise<boolean> {
  const picked = await openDialog({ directory: true, multiple: false });
  if (typeof picked !== "string") return false;
  await openFolder(picked);
  return true;
}

const batcher = createThumbBatcher((events) => useThumbs.getState().applyMany(events));

let subscribed = false;
/** 应用启动时调用一次，把缩略图事件写入 thumbs store。 */
export function subscribeThumbs(): void {
  if (subscribed) return;
  subscribed = true;
  thumbsSubscribe((e) => batcher.push(e)).catch(() => {
    subscribed = false;
  });
}
