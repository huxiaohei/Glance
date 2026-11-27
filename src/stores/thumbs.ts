import { create } from "zustand";
import type { FileId, ThumbEvent, Tier } from "../ipc/types";

export interface ReadyThumb { tier: Tier; v: string }

export interface ThumbsState {
  ready: Map<FileId, ReadyThumb>;   // 已就绪的最高档位，及其生成时的文件版本
  broken: Set<FileId>;
  /** 本机缺系统解码组件（HEIC / AVIF）而读不出的；与 broken 互斥。 */
  noCodec: Set<FileId>;
  apply(e: ThumbEvent): void;
  applyMany(events: ThumbEvent[]): void;   // 一次更新应用多条事件
  markReady(items: { id: FileId; v: string }[], tier: Tier): void;
  /** 清除这些文件的损坏与缺组件标记；就绪状态保留，旧图继续显示到新版本就绪。 */
  forget(ids: FileId[]): void;
  /** 清除全部损坏与缺组件标记（刷新时重试）；就绪状态保留。 */
  clearBroken(): void;
  reset(): void;
}

export const useThumbs = create<ThumbsState>((set) => ({
  ready: new Map(),
  broken: new Set(),
  noCodec: new Set(),

  apply: (e) => useThumbs.getState().applyMany([e]),

  // 事件按顺序生效：ready 说明文件读得出，清除损坏与缺组件标记；同一批里后到的为准
  applyMany: (events) =>
    set((s) => {
      let ready: Map<FileId, ReadyThumb> | null = null;
      const marks = new Marks(s);
      for (const e of events) {
        if (e.type === "broken") {
          marks.unmark("noCodec", e.id);
          marks.mark("broken", e.id);
          continue;
        }
        if (e.type === "noCodec") {
          marks.unmark("broken", e.id);
          marks.mark("noCodec", e.id);
          continue;
        }
        marks.unmark("broken", e.id);
        marks.unmark("noCodec", e.id);
        if (supersedes((ready ?? s.ready).get(e.id), e.tier, e.v)) {
          ready ??= new Map(s.ready);
          ready.set(e.id, { tier: e.tier, v: e.v });
        }
      }
      return { ...(ready && { ready }), ...marks.changed() };
    }),

  markReady: (items, tier) =>
    set((s) => {
      let next: Map<FileId, ReadyThumb> | null = null;
      const marks = new Marks(s);
      for (const { id, v } of items) {
        marks.unmark("broken", id);
        marks.unmark("noCodec", id);
        if (!supersedes((next ?? s.ready).get(id), tier, v)) continue;
        next ??= new Map(s.ready);
        next.set(id, { tier, v });
      }
      return { ...(next && { ready: next }), ...marks.changed() };
    }),

  forget: (ids) =>
    set((s) => {
      const marks = new Marks(s);
      for (const id of ids) {
        marks.unmark("broken", id);
        marks.unmark("noCodec", id);
      }
      return marks.changed();
    }),

  clearBroken: () =>
    set((s) => ({
      ...(s.broken.size > 0 && { broken: new Set<FileId>() }),
      ...(s.noCodec.size > 0 && { noCodec: new Set<FileId>() }),
    })),

  reset: () => set({ ready: new Map(), broken: new Set(), noCodec: new Set() }),
}));

/** 这些图都缺系统解码组件（空列表为假）：编辑与批量入口据此置灰。 */
export function allNoCodec(noCodec: ReadonlySet<FileId>, ids: Iterable<FileId>): boolean {
  let any = false;
  for (const id of ids) {
    if (!noCodec.has(id)) return false;
    any = true;
  }
  return any;
}

type MarkKey = "broken" | "noCodec";

/** 两个标记集合的写时复制：没变的集合保持原对象，订阅者不会被无谓地唤醒。 */
class Marks {
  private next: Partial<Record<MarkKey, Set<FileId>>> = {};
  constructor(private readonly base: Record<MarkKey, Set<FileId>>) {}

  private get(k: MarkKey): Set<FileId> {
    return this.next[k] ?? this.base[k];
  }

  private own(k: MarkKey): Set<FileId> {
    return (this.next[k] ??= new Set(this.base[k]));
  }

  mark(k: MarkKey, id: FileId): void {
    if (!this.get(k).has(id)) this.own(k).add(id);
  }

  unmark(k: MarkKey, id: FileId): void {
    if (this.get(k).has(id)) this.own(k).delete(id);
  }

  changed(): Partial<Record<MarkKey, Set<FileId>>> {
    return this.next;
  }
}

/**
 * 版本不同，或同版本下档位更高，新状态才替换旧状态。版本不同时不比较修改时间的先后：
 * 替换文件（Finder 替换、cp -p、解压）会保留源文件更早的修改时间。后端生成时读完再核对
 * 一次文件状态，迟到的结果描述的也是它读到的那份字节。
 */
function supersedes(old: ReadyThumb | undefined, tier: Tier, v: string): boolean {
  return !old || old.v !== v || old.tier < tier;
}
