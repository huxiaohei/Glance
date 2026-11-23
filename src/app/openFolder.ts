import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, thumbsSubscribe } from "../ipc/api";
import type { OpenErrorCode } from "../ipc/types";
import { useCatalog } from "../stores/catalog";
import { useThumbs } from "../stores/thumbs";
import { create } from "zustand";
import { createOpener } from "./openSession";

/** 最近一次打开失败的错误码（成功或重新打开时清除），供启动页显示。 */
export const useOpenError = create<{ error: OpenErrorCode | null }>(() => ({ error: null }));

const opener = createOpener({
  openPath,
  begin: (info) => {
    useThumbs.getState().reset();
    useCatalog.getState().begin(info);
  },
  apply: (e) => useCatalog.getState().apply(e),
});

/** 打开目录或图片：begin → 事件流写入 catalog；失败时返回错误码。 */
export async function openFolder(path: string, recursive: boolean = true): Promise<OpenErrorCode | null> {
  const error = await opener(path, recursive);
  useOpenError.setState({ error });
  return error;
}

/** 弹出系统目录选择框；取消返回 false。 */
export async function pickAndOpenFolder(): Promise<boolean> {
  const picked = await openDialog({ directory: true, multiple: false });
  if (typeof picked !== "string") return false;
  await openFolder(picked);
  return true;
}

let subscribed = false;
/** 应用启动时调用一次，把缩略图事件写入 thumbs store。 */
export function subscribeThumbs(): void {
  if (subscribed) return;
  subscribed = true;
  thumbsSubscribe((e) => useThumbs.getState().apply(e)).catch(() => {
    subscribed = false;
  });
}
