import type { FileId } from "../ipc/types";

/** 这次拖起来的是哪些图：按下的图在选中里 → 选中且在列表里的那些，按列表顺序；否则只有它。 */
export function dragIds(selected: ReadonlySet<FileId>, listIds: readonly FileId[], pressed: FileId): FileId[] {
  if (!selected.has(pressed)) return [pressed];
  return listIds.filter((id) => selected.has(id));
}

/** 拖到目录 dir 时实际要处理的图（保持顺序）：先去掉已不在条目表里的；移动时再去掉本来就在 dir 里的，复制时不去。 */
export function transferPlan(
  ids: readonly FileId[],
  entries: ReadonlyMap<FileId, { dir: string }>,
  dir: string,
  copy: boolean,
): FileId[] {
  return ids.filter((id) => {
    const e = entries.get(id);
    return e !== undefined && (copy || e.dir !== dir);
  });
}

/** 拖拽时的复制修饰键：macOS 为 Option（altKey），其他平台为 Ctrl（ctrlKey）。 */
export function copyModifier(e: { altKey: boolean; ctrlKey: boolean }, isMac: boolean): boolean {
  return isMac ? e.altKey : e.ctrlKey;
}

/** 按下时带着 Meta、Ctrl 或 Shift：只是选择操作，不开始拖拽，也不推迟收成单选（格子与拖拽共用这一条，各平台相同）。 */
export function selectModifier(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}
