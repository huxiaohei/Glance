import { create } from "zustand";
import { recentsList, recentsPin, recentsRemove } from "../ipc/api";
import type { RecentEntry } from "../ipc/types";

/** 最近目录列表，以后端返回的为准（固定项在前）。 */
export const useRecents = create<{ list: RecentEntry[] }>(() => ({ list: [] }));

/** 调后端并用返回的列表替换 store；失败时保持原列表，不抛。 */
async function replaceWith(request: () => Promise<RecentEntry[]>): Promise<void> {
  try {
    const list = await request();
    useRecents.setState({ list });
  } catch {
    // 读写最近目录失败不影响使用，保留原列表
  }
}

export function loadRecents(): Promise<void> {
  return replaceWith(recentsList);
}

export function pinRecent(path: string, pinned: boolean): Promise<void> {
  return replaceWith(() => recentsPin(path, pinned));
}

export function removeRecent(path: string): Promise<void> {
  return replaceWith(() => recentsRemove(path));
}
