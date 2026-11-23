import { create } from "zustand";
import type { CatalogEvent, FileId, RootInfo } from "../ipc/types";
import { toImageEntry, type ImageEntry } from "../lib/deriveList";

export interface CatalogState {
  root: RootInfo | null;
  entries: Map<FileId, ImageEntry>;
  scanning: boolean;
  version: number;                      // 每次 entries 变化加一（含尺寸补全），供格子占位比例用
  listVersion: number;                  // 仅在条目集合变化（begin/reset/非空批次）时加一，供列表与目录树派生缓存用
  begin(root: RootInfo): void;          // 清空并进入扫描中
  apply(e: CatalogEvent): void;         // generation 与 root 不符的事件直接丢弃
  reset(): void;
}

export const useCatalog = create<CatalogState>((set) => ({
  root: null,
  entries: new Map(),
  scanning: false,
  version: 0,
  listVersion: 0,

  begin: (root) =>
    set((s) => ({
      root,
      entries: new Map(),
      scanning: true,
      version: s.version + 1,
      listVersion: s.listVersion + 1,
    })),

  apply: (e) =>
    set((s) => {
      if (!s.root || e.generation !== s.root.generation) return s;
      switch (e.type) {
        case "batch": {
          if (e.entries.length === 0) return s;
          const entries = new Map(s.entries);
          for (const w of e.entries) entries.set(w.id, toImageEntry(w));
          return { entries, version: s.version + 1, listVersion: s.listVersion + 1 };
        }
        case "done":
          return { scanning: false };
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
      }
    }),

  reset: () =>
    set((s) => ({
      root: null,
      entries: new Map(),
      scanning: false,
      version: s.version + 1,
      listVersion: s.listVersion + 1,
    })),
}));
