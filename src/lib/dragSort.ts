import type { FileId } from "../ipc/types";

/** 等大格子、固定列数的网格：第 0 格左上角、格子尺寸与行列间隙（与指针同一坐标系）。 */
export interface SortGrid {
  left: number;
  top: number;
  cellW: number;
  cellH: number;
  gapX: number;
  gapY: number;
  columns: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * 指针所在的槽位：离哪格的中心线近算哪格（分界在格间隙正中），列夹到 [0, columns-1]、行不小于 0，
 * 结果夹到 [0, count-1]——落在最后一格之后的空槽（含网格下方）算末尾。没有格子时为 0。
 */
export function slotAt(p: { x: number; y: number }, grid: SortGrid, count: number): number {
  if (count <= 0) return 0;
  const pitchX = grid.cellW + grid.gapX;
  const pitchY = grid.cellH + grid.gapY;
  const columns = Math.max(1, grid.columns);
  const col = pitchX > 0 ? clamp(Math.floor((p.x - grid.left + grid.gapX / 2) / pitchX), 0, columns - 1) : 0;
  const row = pitchY > 0 ? Math.max(0, Math.floor((p.y - grid.top + grid.gapY / 2) / pitchY)) : 0;
  return Math.min(row * columns + col, count - 1);
}

/** 把第 from 张挪到第 to 位（to 按挪走之后的列表计，夹到范围内）后的顺序；总是返回新数组。 */
export function previewOrder(order: readonly FileId[], from: number, to: number): FileId[] {
  const out = [...order];
  if (from < 0 || from >= out.length) return out;
  const [id] = out.splice(from, 1);
  out.splice(clamp(to, 0, out.length), 0, id);
  return out;
}
