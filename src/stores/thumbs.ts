import { create } from "zustand";
import type { FileId, ThumbEvent, Tier } from "../ipc/types";

export interface ReadyThumb { tier: Tier; v: string }

export interface ThumbsState {
  ready: Map<FileId, ReadyThumb>;   // 已就绪的最高档位，及其生成时的文件版本
  broken: Set<FileId>;
  apply(e: ThumbEvent): void;
  applyMany(events: ThumbEvent[]): void;   // 一次更新应用多条事件
  markReady(items: { id: FileId; v: string }[], tier: Tier): void;
  /** 清除这些文件的损坏标记；就绪状态保留，旧图继续显示到新版本就绪。 */
  forget(ids: FileId[]): void;
  /** 清除全部损坏标记（刷新时重试）；就绪状态保留。 */
  clearBroken(): void;
  reset(): void;
}

export const useThumbs = create<ThumbsState>((set) => ({
  ready: new Map(),
  broken: new Set(),

  apply: (e) => useThumbs.getState().applyMany([e]),

  // 事件按顺序生效：ready 说明文件读得出，清除损坏标记；同一批里后到的为准
  applyMany: (events) =>
    set((s) => {
      let ready: Map<FileId, ReadyThumb> | null = null;
      let broken: Set<FileId> | null = null;
      for (const e of events) {
        const isBroken = (broken ?? s.broken).has(e.id);
        if (e.type === "broken") {
          if (isBroken) continue;
          broken ??= new Set(s.broken);
          broken.add(e.id);
          continue;
        }
        if (isBroken) {
          broken ??= new Set(s.broken);
          broken.delete(e.id);
        }
        if (supersedes((ready ?? s.ready).get(e.id), e.tier, e.v)) {
          ready ??= new Map(s.ready);
          ready.set(e.id, { tier: e.tier, v: e.v });
        }
      }
      return { ...(ready && { ready }), ...(broken && { broken }) };
    }),

  markReady: (items, tier) =>
    set((s) => {
      let next: Map<FileId, ReadyThumb> | null = null;
      let broken: Set<FileId> | null = null;
      for (const { id, v } of items) {
        if ((broken ?? s.broken).has(id)) {
          broken ??= new Set(s.broken);
          broken.delete(id);
        }
        if (!supersedes((next ?? s.ready).get(id), tier, v)) continue;
        next ??= new Map(s.ready);
        next.set(id, { tier, v });
      }
      return { ...(next && { ready: next }), ...(broken && { broken }) };
    }),

  forget: (ids) =>
    set((s) => {
      if (!ids.some((id) => s.broken.has(id))) return {};
      const broken = new Set(s.broken);
      for (const id of ids) broken.delete(id);
      return { broken };
    }),

  clearBroken: () => set((s) => (s.broken.size === 0 ? {} : { broken: new Set() })),

  reset: () => set({ ready: new Map(), broken: new Set() }),
}));

/**
 * 版本不同，或同版本下档位更高，新状态才替换旧状态。版本不同时不比较修改时间的先后：
 * 替换文件（Finder 替换、cp -p、解压）会保留源文件更早的修改时间。后端生成时读完再核对
 * 一次文件状态，迟到的结果描述的也是它读到的那份字节。
 */
function supersedes(old: ReadyThumb | undefined, tier: Tier, v: string): boolean {
  return !old || old.v !== v || old.tier < tier;
}
