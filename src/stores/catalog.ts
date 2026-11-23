import { create } from "zustand";
import type { CatalogEvent, FileId, RootInfo, WireEntry } from "../ipc/types";
import { toImageEntry, type ImageEntry } from "../lib/deriveList";

export interface CatalogState {
  root: RootInfo | null;
  entries: Map<FileId, ImageEntry>;
  scanning: boolean;
  watchFailed: boolean;                 // 后端无法监听当前目录；begin、reset 时清除
  version: number;                      // 每次 entries 变化加一（含尺寸补全），供格子占位比例用
  listVersion: number;                  // 仅在条目集合变化（begin/reset/非空批次/删除/改名）时加一，供列表与目录树派生缓存用
  /** 进入扫描中。keep 为真（刷新）时保留现有条目，扫描结束时移除没有再出现的。 */
  begin(root: RootInfo, opts?: { keep?: boolean }): void;
  apply(e: CatalogEvent): void;         // generation 与 root 不符的事件直接丢弃
  reset(): void;
}

/** batch 里已存在、且大小或修改时间变了的 id（其缩略图需要重新生成）。 */
export function changedIds(entries: ReadonlyMap<FileId, ImageEntry>, batch: WireEntry[]): FileId[] {
  const ids: FileId[] = [];
  for (const w of batch) {
    const old = entries.get(w.id);
    if (old && (old.size !== w.size || old.mtimeMs !== w.mtimeMs)) ids.push(w.id);
  }
  return ids;
}

// keep 模式下尚未被新一轮扫描确认的 id；只在 begin/apply 里读写，不进入状态
let stale = new Set<FileId>();

export const useCatalog = create<CatalogState>((set) => ({
  root: null,
  entries: new Map(),
  scanning: false,
  watchFailed: false,
  version: 0,
  listVersion: 0,

  begin: (root, opts) =>
    set((s) => {
      if (opts?.keep) {
        stale = new Set(s.entries.keys());
        return { root, scanning: true, watchFailed: false, version: s.version + 1 };
      }
      stale = new Set();
      return {
        root,
        entries: new Map(),
        scanning: true,
        watchFailed: false,
        version: s.version + 1,
        listVersion: s.listVersion + 1,
      };
    }),

  apply: (e) =>
    set((s) => {
      if (!s.root || e.generation !== s.root.generation) return s;
      switch (e.type) {
        case "batch": {
          if (e.entries.length === 0) return s;
          const entries = new Map(s.entries);
          for (const w of e.entries) {
            const next = toImageEntry(w);
            const old = s.entries.get(w.id);
            const same = old && old.size === w.size && old.mtimeMs === w.mtimeMs;
            entries.set(w.id, same && old.width !== undefined ? { ...next, width: old.width, height: old.height } : next);
            stale.delete(w.id);
          }
          return { entries, version: s.version + 1, listVersion: s.listVersion + 1 };
        }
        case "done": {
          const gone = [...stale].filter((id) => s.entries.has(id));
          stale = new Set();
          if (gone.length === 0) return { scanning: false };
          const entries = new Map(s.entries);
          for (const id of gone) entries.delete(id);
          return { scanning: false, entries, version: s.version + 1, listVersion: s.listVersion + 1 };
        }
        case "dims": {
          let entries: Map<FileId, ImageEntry> | null = null;
          for (const { id, w, h } of e.items) {
            const old = (entries ?? s.entries).get(id);
            if (!old) continue;
            entries ??= new Map(s.entries);
            entries.set(id, { ...old, width: w, height: h });
          }
          if (!entries) return s;
          return { entries, version: s.version + 1 };
        }
        case "removed": {
          if (!e.ids.some((id) => s.entries.has(id))) return s;
          const entries = new Map(s.entries);
          for (const id of e.ids) {
            entries.delete(id);
            stale.delete(id);
          }
          return { entries, version: s.version + 1, listVersion: s.listVersion + 1 };
        }
        case "renamed": {
          let entries: Map<FileId, ImageEntry> | null = null;
          for (const { id, relPath } of e.items) {
            const old = (entries ?? s.entries).get(id);
            if (!old) continue;
            entries ??= new Map(s.entries);
            entries.set(id, { ...old, ...toImageEntry({ id, relPath, size: old.size, mtimeMs: old.mtimeMs }) });
          }
          if (!entries) return s;
          return { entries, version: s.version + 1, listVersion: s.listVersion + 1 };
        }
        case "watchFailed":
          return s.watchFailed ? s : { watchFailed: true };
      }
    }),

  reset: () =>
    set((s) => {
      stale = new Set();
      return {
        root: null,
        entries: new Map(),
        scanning: false,
        watchFailed: false,
        version: s.version + 1,
        listVersion: s.listVersion + 1,
      };
    }),
}));
