import { create } from "zustand";
import type { CatalogEvent, FileId, RootInfo } from "../ipc/types";
import { toImageEntry, type ImageEntry } from "../lib/deriveList";

export interface CatalogState {
  root: RootInfo | null;
  entries: Map<FileId, ImageEntry>;
  scanning: boolean;
  version: number;                      // 每次 entries 变化加一，供派生缓存用
  begin(root: RootInfo): void;          // 清空并进入扫描中
  apply(e: CatalogEvent): void;         // generation 与 root 不符的事件直接丢弃
  reset(): void;
}

export const useCatalog = create<CatalogState>((set) => ({
  root: null,
  entries: new Map(),
  scanning: false,
  version: 0,

  begin: (root) =>
    set((s) => ({ root, entries: new Map(), scanning: true, version: s.version + 1 })),

  apply: (e) =>
    set((s) => {
      if (!s.root || e.generation !== s.root.generation) return s;
      switch (e.type) {
        case "batch": {
          const entries = new Map(s.entries);
          for (const w of e.entries) entries.set(w.id, toImageEntry(w));
          return { entries, version: s.version + 1 };
        }
        case "done":
          return { scanning: false };
        case "dims": {
          const entries = new Map(s.entries);
          for (const { id, w, h } of e.items) {
            const old = entries.get(id);
            if (old) entries.set(id, { ...old, width: w, height: h });
          }
          return { entries, version: s.version + 1 };
        }
      }
    }),

  reset: () =>
    set((s) => ({ root: null, entries: new Map(), scanning: false, version: s.version + 1 })),
}));
