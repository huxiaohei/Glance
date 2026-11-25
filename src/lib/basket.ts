import type { BasketEntry, FileId } from "../ipc/types";
import type { ImageEntry } from "./deriveList";

export interface BasketItem {
  id: FileId; name: string; dirName: string; size: number; mtimeMs: number; width?: number; height?: number;
}

/** 空格的规则：targets 里只要有不在篮里的，就把它们按 targets 顺序追加；全在则全部移出。 */
export function toggleMany(
  order: readonly FileId[],
  targets: readonly FileId[],
): { order: FileId[]; added: FileId[]; removed: FileId[] } {
  if (targets.length === 0) return { order: [...order], added: [], removed: [] };
  const inBasket = new Set(order);
  const seen = new Set<FileId>();
  const added: FileId[] = [];
  for (const id of targets) {
    if (inBasket.has(id) || seen.has(id)) continue;
    seen.add(id);
    added.push(id);
  }
  if (added.length > 0) return { order: [...order, ...added], added, removed: [] };
  const gone = new Set(targets);
  return { order: order.filter((id) => !gone.has(id)), added: [], removed: [...targets] };
}

/** 出现次数最多的“宽×高”；尺寸未知的不计；并列最多或没有已知尺寸时返回 null。 */
export function majoritySize(items: readonly { width?: number; height?: number }[]): { w: number; h: number } | null {
  const counts = new Map<string, { w: number; h: number; n: number }>();
  for (const it of items) {
    if (it.width === undefined || it.height === undefined) continue;
    const key = `${it.width}x${it.height}`;
    const c = counts.get(key);
    if (c) c.n++; else counts.set(key, { w: it.width, h: it.height, n: 1 });
  }
  let best: { w: number; h: number; n: number } | null = null;
  let tie = false;
  for (const c of counts.values()) {
    if (best === null || c.n > best.n) { best = c; tie = false; }
    else if (c.n === best.n) tie = true;
  }
  return best === null || tie ? null : { w: best.w, h: best.h };
}

export function fromImageEntry(e: ImageEntry, dirName: string): BasketItem {
  return { id: e.id, name: e.name, dirName, size: e.size, mtimeMs: e.mtimeMs, width: e.width, height: e.height };
}

export function fromBasketEntry(e: BasketEntry): BasketItem {
  return {
    id: e.id, name: e.name, dirName: e.dirName, size: e.size, mtimeMs: e.mtimeMs,
    width: e.w ?? undefined, height: e.h ?? undefined,
  };
}
