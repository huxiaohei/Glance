import type { FileId } from "../ipc/types";

/** 列表变化后当前图应该是谁：id 仍在 next 里 → id；否则取它在 prev 里的位置，
 *  落到 next 中该位置的图（越界取最后一张）；next 为空 → null。 */
export function resolveCurrent(prev: readonly FileId[], next: readonly FileId[], id: FileId): FileId | null {
  if (next.length === 0) return null;
  if (next.includes(id)) return id;
  const i = prev.indexOf(id);
  return next[Math.min(Math.max(i, 0), next.length - 1)];
}

/** 相邻的图：到头返回 null。 */
export function neighbor(ids: readonly FileId[], id: FileId, step: -1 | 1): FileId | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + step] ?? null;
}
