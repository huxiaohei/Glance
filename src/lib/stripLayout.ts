import type { FileId } from "../ipc/types";
import type { ImageList } from "./deriveList";

export const STRIP_ITEM = 56, STRIP_GAP = 4, STRIP_DIVIDER = 9;   // 分组之间多出的宽度（含 1 px 细线）
export interface StripItem { id: FileId; left: number; groupStart: boolean }
export interface StripLayout { items: StripItem[]; width: number }

/** 缩略图条的横向布局：等宽方格依次排开，分组之间多留出分隔的宽度。第一个分组前不加分隔；折叠的分组没有项。 */
export function layoutStrip(list: ImageList): StripLayout {
  const items: StripItem[] = [];
  let x = 0;
  for (const g of list.groups) {
    for (let k = 0; k < g.count; k++) {
      const groupStart = k === 0 && items.length > 0;
      if (items.length > 0) x += STRIP_ITEM + STRIP_GAP + (groupStart ? STRIP_DIVIDER : 0);
      items.push({ id: list.ids[g.start + k], left: x, groupStart });
    }
  }
  return { items, width: items.length > 0 ? x + STRIP_ITEM : 0 };
}

/** 让第 index 项完整可见所需的 scrollLeft：已完整可见则返回 current；否则把它居中，并夹在 [0, width - view]。 */
export function scrollToShow(layout: StripLayout, index: number, current: number, view: number): number {
  const item = layout.items[index];
  if (!item) return current;
  if (item.left >= current && item.left + STRIP_ITEM <= current + view) return current;
  const centered = item.left + STRIP_ITEM / 2 - view / 2;
  return Math.max(0, Math.min(centered, layout.width - view));
}

/** [scrollLeft - overscan, scrollLeft + view + overscan) 内的 id，从左到右。 */
export function stripVisible(layout: StripLayout, scrollLeft: number, view: number, overscan: number): FileId[] {
  const { items } = layout;
  const lo = scrollLeft - overscan, hi = scrollLeft + view + overscan;
  // 二分找第一个右缘越过 lo 的项
  let a = 0, b = items.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (items[m].left + STRIP_ITEM > lo) b = m;
    else a = m + 1;
  }
  const out: FileId[] = [];
  for (let i = a; i < items.length && items[i].left < hi; i++) out.push(items[i].id);
  return out;
}
