import type { FileId } from "../ipc/types";
import type { ImageList } from "./deriveList";

export interface Selection { ids: ReadonlySet<FileId>; focus: FileId | null; anchor: FileId | null }

export const EMPTY: Selection = { ids: new Set(), focus: null, anchor: null };

function sameSet(a: ReadonlySet<FileId>, b: ReadonlySet<FileId>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** next 与 sel 内容相同时返回 sel 本身。 */
function keepIfSame(sel: Selection, next: Selection): Selection {
  return sel.focus === next.focus && sel.anchor === next.anchor && sameSet(sel.ids, next.ids) ? sel : next;
}

/** 单击：只选它，focus = anchor = id。 */
export function selectOnly(id: FileId): Selection {
  return { ids: new Set([id]), focus: id, anchor: id };
}

/** 右键落在一张图上：它已在选中集合里 → 选中不变，只把焦点移到它；否则 → 只选它。 */
export function selectForContext(sel: Selection, id: FileId): Selection {
  return sel.ids.has(id) ? { ids: sel.ids, focus: id, anchor: sel.anchor } : selectOnly(id);
}

/** Cmd/Ctrl + 单击：切换它；focus = anchor = id。 */
export function toggle(sel: Selection, id: FileId): Selection {
  const ids = new Set(sel.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, focus: id, anchor: id };
}

/** Shift + 单击：选中 anchor 到 id 之间（含两端），替换原选中；anchor 不变，focus = id。 */
export function selectRange(sel: Selection, list: ImageList, id: FileId): Selection {
  const a = sel.anchor === null ? -1 : list.ids.indexOf(sel.anchor);
  const b = list.ids.indexOf(id);
  if (a < 0 || b < 0) return keepIfSame(sel, selectOnly(id));
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return keepIfSame(sel, { ids: new Set(list.ids.slice(lo, hi + 1)), focus: id, anchor: sel.anchor });
}

/** 方向键：extend 为假等同 selectOnly(target)；为真等同 selectRange。 */
export function moveTo(sel: Selection, list: ImageList, target: FileId, extend: boolean): Selection {
  return extend ? selectRange(sel, list, target) : keepIfSame(sel, selectOnly(target));
}

/** 选中整组（dir），替换原选中；focus = anchor = 该组第一张。组为空或不存在时返回原对象。 */
export function selectGroup(sel: Selection, list: ImageList, dir: string): Selection {
  const g = list.groups.find((x) => x.dir === dir);
  if (!g || g.count === 0) return sel;
  const ids = list.ids.slice(g.start, g.start + g.count);
  return keepIfSame(sel, { ids: new Set(ids), focus: ids[0], anchor: ids[0] });
}

/**
 * 第一次：选中 focus 所在的分组（无 focus 时为第一组）；该组已全部选中时：选中全部。
 * focus 与 anchor 不变（原为 null 时取所选范围的第一张）。
 */
export function selectAll(sel: Selection, list: ImageList): Selection {
  const visible = list.groups.filter((g) => g.count > 0);
  if (visible.length === 0) return sel;
  const fi = sel.focus === null ? -1 : list.ids.indexOf(sel.focus);
  const group = visible.find((g) => fi >= g.start && fi < g.start + g.count) ?? visible[0];
  const groupIds = list.ids.slice(group.start, group.start + group.count);
  const groupDone = groupIds.every((id) => sel.ids.has(id));
  const ids = groupDone ? list.ids : groupIds;
  const first = ids[0];
  return keepIfSame(sel, {
    ids: new Set(ids),
    focus: sel.focus ?? first,
    anchor: sel.anchor ?? first,
  });
}

/** 被移除的 x 落到哪里：x 仍在 → x；否则 prevOrder 里它后面最近的仍存在的 id，没有则前面最近的；
 *  都没有、或 prevOrder 里没有 x → null。 */
function landing(x: FileId | null, entries: ReadonlyMap<FileId, unknown>, prevOrder: readonly FileId[]): FileId | null {
  if (x === null || entries.has(x)) return x;
  const i = prevOrder.indexOf(x);
  if (i < 0) return null;
  for (let j = i + 1; j < prevOrder.length; j++) if (entries.has(prevOrder[j])) return prevOrder[j];
  for (let j = i - 1; j >= 0; j--) if (entries.has(prevOrder[j])) return prevOrder[j];
  return null;
}

/**
 * 修剪：ids 去掉不存在的；焦点（与锚点）不存在时落到 prevOrder 里它后面最近的仍存在的 id，没有则前面最近的，
 * 再没有则 null。只移动焦点，不把落到的图加入选中。entries 直接传条目表；prevOrder 是变化前的列表顺序。
 */
export function prune(sel: Selection, entries: ReadonlyMap<FileId, unknown>, prevOrder: readonly FileId[]): Selection {
  const focus = landing(sel.focus, entries, prevOrder);
  const anchor = landing(sel.anchor, entries, prevOrder);
  let drop = false;
  for (const id of sel.ids) if (!entries.has(id)) { drop = true; break; }
  if (!drop && focus === sel.focus && anchor === sel.anchor) return sel;
  return { ids: drop ? new Set([...sel.ids].filter((id) => entries.has(id))) : sel.ids, focus, anchor };
}

/** 框选：选中 ids；additive 为真时与 base 取并集。focus = anchor = ids 的最后一个（为空时沿用 base 的）。 */
export function selectMany(base: Selection, ids: FileId[], additive: boolean): Selection {
  const set = new Set(additive ? base.ids : []);
  for (const id of ids) set.add(id);
  const last = ids.length > 0 ? ids[ids.length - 1] : null;
  return keepIfSame(base, {
    ids: set,
    focus: last ?? base.focus,
    anchor: last ?? base.anchor,
  });
}
