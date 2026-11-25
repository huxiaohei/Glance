import { create, type StoreApi, type UseBoundStore } from "zustand";
import { t } from "../i18n";
import type { BasketEntry, FileId } from "../ipc/types";
import { fromBasketEntry, fromImageEntry, toggleMany, type BasketItem } from "../lib/basket";
import type { ImageEntry } from "../lib/deriveList";
import { useCatalog } from "./catalog";
import { showToast } from "./toast";

export const BASKET_SOFT_LIMIT = 100;

export interface BasketSnapshot { order: FileId[]; items: Map<FileId, BasketItem>; missing: Set<FileId> }

export interface BasketState {
  order: FileId[];
  items: Map<FileId, BasketItem>;
  missing: Set<FileId>;
  toggle(targets: FileId[]): void;
  remove(ids: FileId[]): BasketSnapshot;
  restore(snap: BasketSnapshot): void;
  clear(): BasketSnapshot;
  applyCheck(results: (BasketEntry | null)[], ids: FileId[]): void;
}

function dirNameOf(e: ImageEntry): string {
  if (e.dir === "") return useCatalog.getState().root?.name ?? "";
  const i = e.dir.lastIndexOf("/");
  return i < 0 ? e.dir : e.dir.slice(i + 1);
}

const snapshotOf = (e: ImageEntry): BasketItem => fromImageEntry(e, dirNameOf(e));

function sameItem(a: BasketItem, b: BasketItem): boolean {
  return a.name === b.name && a.dirName === b.dirName && a.size === b.size && a.mtimeMs === b.mtimeMs
    && a.width === b.width && a.height === b.height;
}

export const useBasket: UseBoundStore<StoreApi<BasketState>> = create<BasketState>((set, get) => ({
  order: [],
  items: new Map(),
  missing: new Set(),

  toggle: (targets) =>
    set((s) => {
      const entries = useCatalog.getState().entries;
      const known = targets.filter((id) => s.items.has(id) || entries.has(id));
      const r = toggleMany(s.order, known);
      if (r.added.length === 0 && r.removed.length === 0) return s;
      const items = new Map(s.items);
      for (const id of r.removed) items.delete(id);
      for (const id of r.added) { items.set(id, snapshotOf(entries.get(id)!)); seen.add(id); }
      let missing = s.missing;
      if (r.removed.some((id) => missing.has(id))) {
        missing = new Set(missing);
        for (const id of r.removed) missing.delete(id);
      }
      if (s.order.length <= BASKET_SOFT_LIMIT && r.order.length > BASKET_SOFT_LIMIT) {
        showToast({ text: t("basket.tooMany") });
      }
      return { order: r.order, items, missing };
    }),

  remove: (ids) => {
    const before: BasketSnapshot = { order: get().order, items: get().items, missing: get().missing };
    set((s) => {
      const gone = new Set(ids);
      if (!s.order.some((id) => gone.has(id))) return s;
      const items = new Map(s.items);
      const missing = new Set(s.missing);
      for (const id of gone) { items.delete(id); missing.delete(id); }
      return { order: s.order.filter((id) => !gone.has(id)), items, missing };
    });
    return before;
  },

  restore: (snap) =>
    set((s) => {
      const missing = new Set(s.missing);
      for (const id of snap.missing) missing.add(id);
      return { order: [...snap.order], items: new Map(snap.items), missing };
    }),

  clear: () => {
    const before: BasketSnapshot = { order: get().order, items: get().items, missing: get().missing };
    set((s) => (s.order.length === 0 ? s : { order: [], items: new Map(), missing: new Set() }));
    return before;
  },

  applyCheck: (results, ids) =>
    set((s) => {
      const items = new Map(s.items);
      const missing = new Set(s.missing);
      ids.forEach((id, i) => {
        if (!s.items.has(id)) return;
        const r = results[i];
        if (r) { items.set(id, fromBasketEntry(r)); missing.delete(id); }
        else missing.add(id);
      });
      return { items, missing };
    }),
}));

/** 当前目录里有就用 catalog 的实时条目，否则用快照。 */
export function basketItem(id: FileId): BasketItem | undefined {
  const e = useCatalog.getState().entries.get(id);
  if (e) return snapshotOf(e);
  return useBasket.getState().items.get(id);
}

// 当前根目录里确实出现过的篮内 id：只有见过又不见了才算缺失（刚打开目录、条目还没到时不误判）。换根目录时清空。
const seen = new Set<FileId>();

// 同一目录里条目集合变化（删除、改名、尺寸补全）或扫描结束时，与篮子对账。
// 换目录（路径变化）什么都不做：篮子保留着别的目录的图。扫描中不判缺失（条目还没读全）。
function reconcile(): void {
  const { entries, scanning } = useCatalog.getState();
  const s = useBasket.getState();
  let items: Map<FileId, BasketItem> | null = null;
  let missing: Set<FileId> | null = null;
  for (const id of s.order) {
    const e = entries.get(id);
    if (e) {
      seen.add(id);
      const snap = snapshotOf(e);
      const old = s.items.get(id);
      if (!old || !sameItem(old, snap)) { items ??= new Map(s.items); items.set(id, snap); }
      if (s.missing.has(id)) { missing ??= new Set(s.missing); missing.delete(id); }
    } else if (!scanning && seen.has(id) && !s.missing.has(id)) {
      missing ??= new Set(s.missing);
      missing.add(id);
    }
  }
  if (items || missing) useBasket.setState({ ...(items && { items }), ...(missing && { missing }) });
}

useCatalog.subscribe((state, prev) => {
  if (state.root?.path !== prev.root?.path) seen.clear();
  if (state.root === null || state.root.path !== prev.root?.path) return;
  if (state.version === prev.version && state.scanning === prev.scanning) return;
  reconcile();
});
