import type { FileId } from "../ipc/types";
import type { BasketItem } from "../lib/basket";
import type { ImageEntry, ImageList } from "../lib/deriveList";
import { useBasket } from "../stores/basket";
import { useCatalog } from "../stores/catalog";
import { useNav, type NavState, type SingleSource } from "../stores/nav";
import { getImageList, useImageList } from "./useImageList";

/**
 * 单张视图的“列表 + 条目查找”按来源取：folder 是当前目录派生的列表与 catalog 条目；basket 是对比篮里
 * 未缺失的图（按篮内顺序，只有一个分组）与篮内条目（在当前目录里的用 catalog 条目，否则用快照）。
 * 单张视图与它的命令只经这里取列表和条目，不直接读 useImageList / catalog。
 */

const sourceOf = (stack: NavState["stack"]): SingleSource | null => {
  const top = stack[stack.length - 1];
  return top.kind === "single" ? top.source : null;
};

/** 栈顶 single 的来源；栈顶不是 single 时为 null。 */
export function singleSource(): SingleSource | null {
  return sourceOf(useNav.getState().stack);
}

let basketCache: { order: FileId[]; missing: Set<FileId>; list: ImageList } | null = null;

/** 对比篮派生的列表：order 与 missing 不变时返回同一个对象。 */
function basketList(): ImageList {
  const { order, missing } = useBasket.getState();
  if (!basketCache || basketCache.order !== order || basketCache.missing !== missing) {
    const ids = missing.size === 0 ? [...order] : order.filter((id) => !missing.has(id));
    const n = ids.length;
    basketCache = { order, missing, list: { ids, groups: n === 0 ? [] : [{ dir: "", start: 0, count: n, total: n }] } };
  }
  return basketCache.list;
}

/** 单张视图的有序列表。栈顶不是 single 时按 folder 处理。 */
export function getSingleList(): ImageList {
  return singleSource() === "basket" ? basketList() : getImageList();
}

/** 组件里使用：订阅两种来源的输入，返回 getSingleList() 的结果。 */
export function useSingleList(): ImageList {
  useNav((s) => sourceOf(s.stack));
  useImageList();
  useBasket((s) => s.order);
  useBasket((s) => s.missing);
  return getSingleList();
}

// 快照换成条目：同一快照对象换出同一个条目，供依赖它的效果与选择器保持稳定
const fromSnapshot = new WeakMap<BasketItem, ImageEntry>();
function snapshotEntry(item: BasketItem): ImageEntry {
  let e = fromSnapshot.get(item);
  if (!e) {
    e = {
      id: item.id, relPath: item.name, dir: "", name: item.name, size: item.size, mtimeMs: item.mtimeMs,
      width: item.width, height: item.height,
    };
    fromSnapshot.set(item, e);
  }
  return e;
}

function entryOf(source: SingleSource | null, catalogEntry: ImageEntry | undefined, item: BasketItem | undefined) {
  if (catalogEntry || source !== "basket") return catalogEntry;
  return item ? snapshotEntry(item) : undefined;
}

/** 单张视图里一张图的条目：当前目录里有就用 catalog 条目；basket 来源下不在当前目录的用篮内快照
 *  （relPath 取文件名，dir 为 ""）。 */
export function getSingleEntry(id: FileId): ImageEntry | undefined {
  return entryOf(singleSource(), useCatalog.getState().entries.get(id), useBasket.getState().items.get(id));
}

/** 组件里使用的 getSingleEntry。 */
export function useSingleEntry(id: FileId): ImageEntry | undefined {
  const source = useNav((s) => sourceOf(s.stack));
  const catalogEntry = useCatalog((s) => s.entries.get(id));
  const item = useBasket((s) => s.items.get(id));
  return entryOf(source, catalogEntry, item);
}
