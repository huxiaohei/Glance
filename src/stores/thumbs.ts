import { create } from "zustand";
import type { FileId, ThumbEvent, Tier } from "../ipc/types";

export interface ThumbsState {
  ready: Map<FileId, Tier>;     // 已就绪的最高档位
  broken: Set<FileId>;
  apply(e: ThumbEvent): void;
  applyMany(events: ThumbEvent[]): void;   // 一次更新应用多条事件
  markReady(ids: FileId[], tier: Tier): void;
  reset(): void;
}

export const useThumbs = create<ThumbsState>((set) => ({
  ready: new Map(),
  broken: new Set(),

  apply: (e) => useThumbs.getState().applyMany([e]),

  applyMany: (events) =>
    set((s) => {
      let ready: Map<FileId, Tier> | null = null;
      let broken: Set<FileId> | null = null;
      for (const e of events) {
        if (e.type === "broken") {
          if (s.broken.has(e.id) || broken?.has(e.id)) continue;
          broken ??= new Set(s.broken);
          broken.add(e.id);
        } else if (((ready ?? s.ready).get(e.id) ?? 0) < e.tier) {
          ready ??= new Map(s.ready);
          ready.set(e.id, e.tier);
        }
      }
      return { ...(ready && { ready }), ...(broken && { broken }) };
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
