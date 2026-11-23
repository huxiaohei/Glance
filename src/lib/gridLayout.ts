import type { FileId } from "../ipc/types";
import type { ImageList } from "./deriveList";

export const GAP = 8, HEADER_HEIGHT = 32, LABEL_HEIGHT = 24;
/** 滚动区左右内边距：内容区从滚动区左边缘向右 GRID_PAD 处开始。 */
/** 与 grid.css 里 .grid-row / .group-header 的左右 padding（calc(2 * var(--gap))）保持一致。 */
export const GRID_PAD = 16;

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

/**
 * 缩略图请求顺序：先与视口相交的行（自上而下），再视口下方 overscan 内的行（自上而下），
 * 最后视口上方 overscan 内的行（离视口近的在前）。
 */
export function wantedIds(layout: GridLayout, scrollTop: number, viewHeight: number, overscan: number): FileId[] {
  const viewEnd = scrollTop + viewHeight;
  const start = scrollTop - overscan;
  const end = viewEnd + overscan;
  const inView: FileId[] = [];
  const below: FileId[] = [];
  const above: FileId[][] = [];
  for (const r of layout.rows) {
    if (r.top >= end) break;
    if (r.kind !== "images") continue;
    const bottom = r.top + r.height;
    if (bottom <= start) continue;
    if (r.top >= viewEnd) below.push(...r.ids);
    else if (bottom <= scrollTop) above.push(r.ids);
    else inView.push(...r.ids);
  }
  return [...inView, ...below, ...above.reverse().flat()];
}

// 坐标系是内容区（与 Row.top 相同，x 从内容区左边缘算起）
export interface Rect { x0: number; y0: number; x1: number; y1: number } // 不要求 x0 <= x1

/** 与矩形相交的格子（含文件名标签区域），按列表顺序。对布局做几何计算，不依赖 DOM。 */
export function idsInRect(layout: GridLayout, cell: number, rect: Rect): FileId[] {
  const xMin = Math.min(rect.x0, rect.x1), xMax = Math.max(rect.x0, rect.x1);
  const yMin = Math.min(rect.y0, rect.y1), yMax = Math.max(rect.y0, rect.y1);
  const rows = layout.rows;
  // rows 按 top 升序且互不重叠：二分找第一行底边 >= yMin 的行
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height < yMin) lo = mid + 1; else hi = mid;
  }
  const out: FileId[] = [];
  for (let r = lo; r < rows.length && rows[r].top <= yMax; r++) {
    const row = rows[r];
    if (row.kind !== "images") continue;
    row.ids.forEach((id, i) => {
      const x = i * (cell + GAP);
      if (x <= xMax && x + cell >= xMin) out.push(id);
    });
  }
  return out;
}

export type Move = "left" | "right" | "up" | "down" | "home" | "end";

/** id 所在行在 layout.rows 里的下标，不在则 -1。 */
export function rowIndexOf(layout: GridLayout, id: FileId): number {
  return layout.rows.findIndex((r) => r.kind === "images" && r.ids.includes(id));
}

/**
 * left/right 沿 list.ids 前后移动（跨分组）；up/down 到上一/下一图片行的同一列，
 * 该行不够长时落到行末；home/end 到第一/最后一张。到头时返回原 id。id 不在布局里返回 null。
 */
export function moveInLayout(layout: GridLayout, list: ImageList, id: FileId, move: Move): FileId | null {
  const r = rowIndexOf(layout, id);
  if (r < 0) return null;
  const ids = list.ids;
  switch (move) {
    case "home": return ids[0] ?? id;
    case "end": return ids[ids.length - 1] ?? id;
    case "left":
    case "right": {
      const i = ids.indexOf(id) + (move === "left" ? -1 : 1);
      return i < 0 || i >= ids.length ? id : ids[i];
    }
    case "up":
    case "down": {
      const step = move === "up" ? -1 : 1;
      let j = r + step;
      while (j >= 0 && j < layout.rows.length && layout.rows[j].kind !== "images") j += step;
      const target = layout.rows[j];
      if (!target || target.kind !== "images") return id;
      const cur = layout.rows[r];
      const col = cur.kind === "images" ? cur.ids.indexOf(id) : 0;
      return target.ids[Math.min(col, target.ids.length - 1)];
    }
  }
}
