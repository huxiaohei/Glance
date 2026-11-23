import { create } from "zustand";
import type { FileId, ThumbEvent, Tier } from "../ipc/types";

export interface ThumbsState {
  ready: Map<FileId, Tier>;     // 已就绪的最高档位
  broken: Set<FileId>;
  apply(e: ThumbEvent): void;
  markReady(ids: FileId[], tier: Tier): void;
  reset(): void;
}

export const useThumbs = create<ThumbsState>((set) => ({
  ready: new Map(),
  broken: new Set(),

  apply: (e) =>
    set((s) => {
      if (e.type === "broken") {
        if (s.broken.has(e.id)) return s;
        return { broken: new Set(s.broken).add(e.id) };
      }
      return withReady(s.ready, [e.id], e.tier);
    }),

  markReady: (ids, tier) => set((s) => withReady(s.ready, ids, tier)),

  reset: () => set({ ready: new Map(), broken: new Set() }),
}));

function withReady(ready: Map<FileId, Tier>, ids: FileId[], tier: Tier): Partial<ThumbsState> {
  let next: Map<FileId, Tier> | null = null;
  for (const id of ids) {
    if ((ready.get(id) ?? 0) >= tier) continue;
    next ??= new Map(ready);
    next.set(id, tier);
  }
  return next ? { ready: next } : {};
}
