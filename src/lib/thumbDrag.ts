import type { FileId } from "../ipc/types";

/** 这次拖起来的是哪些图：按下的图在选中里 → 选中且在列表里的那些，按列表顺序；否则只有它。 */
export function dragIds(selected: ReadonlySet<FileId>, listIds: readonly FileId[], pressed: FileId): FileId[] {
  if (!selected.has(pressed)) return [pressed];
  return listIds.filter((id) => selected.has(id));
}
