import type { FileId } from "../ipc/types";
import type { ImageList } from "./deriveList";

export const GAP = 8, HEADER_HEIGHT = 32, LABEL_HEIGHT = 24;

export type Row =
  | { kind: "header"; dir: string; count: number; total: number; top: number; height: number }
  | { kind: "images"; ids: FileId[]; top: number; height: number };
export interface GridLayout { columns: number; rows: Row[]; totalHeight: number }

/** width 是内容区宽度，cell 是缩略图边长。 */
export function layoutGrid(list: ImageList, width: number, cell: number): GridLayout {
  const columns = Math.max(1, Math.floor((width + GAP) / (cell + GAP)));
  const rows: Row[] = [];
  let y = 0;
  let afterImages = false; // 上一行是图片行时，下一行之前要留 GAP
  for (const g of list.groups) {
    if (afterImages) y += GAP;
    rows.push({ kind: "header", dir: g.dir, count: g.count, total: g.total, top: y, height: HEADER_HEIGHT });
    y += HEADER_HEIGHT;
    afterImages = false;
    for (let i = 0; i < g.count; i += columns) {
      if (afterImages) y += GAP;
      const ids = list.ids.slice(g.start + i, g.start + Math.min(i + columns, g.count));
      const height = cell + LABEL_HEIGHT;
      rows.push({ kind: "images", ids, top: y, height });
      y += height;
      afterImages = true;
    }
  }
  return { columns, rows, totalHeight: y };
}

/** [scrollTop, scrollTop + viewHeight) 范围内（上下各扩 overscan 像素）可见的图片 ID，按从上到下的顺序。 */
export function visibleIds(layout: GridLayout, scrollTop: number, viewHeight: number, overscan: number): FileId[] {
  const start = scrollTop - overscan;
  const end = scrollTop + viewHeight + overscan;
  const out: FileId[] = [];
  for (const r of layout.rows) {
    if (r.top >= end) break;
    if (r.kind === "images" && r.top + r.height > start) out.push(...r.ids);
  }
  return out;
}
