import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileId } from "../ipc/types";

/**
 * 已知是动图的图：编辑入口据此置灰。来源是详情面板读到的结果与进入编辑被拒（animated）；
 * 不为此单独请求详情，没见过的图按可编辑处理（按 E 时由后端拒绝并提示）。
 */
export const useAnimated: UseBoundStore<StoreApi<{ ids: ReadonlySet<FileId> }>> = create<{ ids: ReadonlySet<FileId> }>(() => ({
  ids: new Set(),
}));

/** 记下这张图是不是动图（文件可能被改写，所以也会移除）。 */
export function noteAnimated(id: FileId, animated: boolean): void {
  const { ids } = useAnimated.getState();
  if (ids.has(id) === animated) return;
  const next = new Set(ids);
  if (animated) next.add(id);
  else next.delete(id);
  useAnimated.setState({ ids: next });
}
