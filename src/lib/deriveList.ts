import type { FileId, WireEntry } from "../ipc/types";
import { naturalCompare } from "./naturalCompare";

export interface ImageEntry {
  id: FileId; relPath: string;
  dir: string;      // 所在目录相对根的路径，根目录为 ""
  name: string;     // 文件名
  size: number; mtimeMs: number; width?: number; height?: number;
}

/** 宽高都已知且为正：尺寸可以显示。 */
export function hasSize(e: ImageEntry): e is ImageEntry & { width: number; height: number } {
  return e.width !== undefined && e.height !== undefined && e.width > 0 && e.height > 0;
}

export function toImageEntry(w: WireEntry): ImageEntry {
  const i = w.relPath.lastIndexOf("/");
  return {
    id: w.id, relPath: w.relPath,
    dir: i < 0 ? "" : w.relPath.slice(0, i),
    name: i < 0 ? w.relPath : w.relPath.slice(i + 1),
    size: w.size, mtimeMs: w.mtimeMs,
  };
}

const segmentsOf = (p: string): string[] => (p === "" ? [] : p.split("/"));

function compareSegments(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = naturalCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** 逐段自然比较 "/" 分隔的路径：父目录排在子目录前，"" 最先。分组顺序与目录树顺序共用它。 */
export function comparePaths(a: string, b: string): number {
  return compareSegments(segmentsOf(a), segmentsOf(b));
}

/** 按 comparePaths 排序；每个路径只拆分一次。 */
function sortPaths(paths: string[]): string[] {
  const segs = new Map(paths.map((p) => [p, segmentsOf(p)] as const));
  return [...paths].sort((a, b) => compareSegments(segs.get(a)!, segs.get(b)!));
}

export type SortKey = "name" | "mtime" | "size";
export interface ListOptions {
  sort: SortKey;
  includeSubdirs: boolean;
  dirFilter: string | null;            // 目录树选中的目录；null 表示“全部图片”
  collapsed: ReadonlySet<string>;      // 折叠的分组（dir）
}
export interface Group { dir: string; start: number; count: number; total: number }
export interface ImageList { ids: FileId[]; groups: Group[] }

function comparator(sort: SortKey): (a: ImageEntry, b: ImageEntry) => number {
  const byName = (a: ImageEntry, b: ImageEntry) => naturalCompare(a.name, b.name);
  switch (sort) {
    case "name": return byName;
    case "mtime": return (a, b) => b.mtimeMs - a.mtimeMs || byName(a, b);
    case "size": return (a, b) => b.size - a.size || byName(a, b);
  }
}

export function deriveList(entries: Iterable<ImageEntry>, opts: ListOptions): ImageList {
  const base = opts.dirFilter ?? "";
  const prefix = base + "/";
  const byDir = new Map<string, ImageEntry[]>();
  for (const e of entries) {
    const inScope = opts.includeSubdirs
      ? base === "" || e.dir === base || e.dir.startsWith(prefix)
      : e.dir === base;
    if (!inScope) continue;
    const list = byDir.get(e.dir);
    if (list) list.push(e); else byDir.set(e.dir, [e]);
  }

  const dirs = sortPaths([...byDir.keys()]);
  const cmp = comparator(opts.sort);
  const ids: FileId[] = [];
  const groups: Group[] = [];
  for (const dir of dirs) {
    const items = byDir.get(dir)!;
    const total = items.length;
    const collapsed = opts.collapsed.has(dir);
    groups.push({ dir, start: ids.length, count: collapsed ? 0 : total, total });
    if (!collapsed) {
      items.sort(cmp);
      for (const it of items) ids.push(it.id);
    }
  }
  return { ids, groups };
}

export interface DirNode { dir: string; name: string; depth: number; count: number; total: number }

/** 所有含图片的目录及其祖先，按路径自然排序（深度优先）；不含根。count 为直属张数，total 含下级。 */
export function dirTree(entries: Iterable<ImageEntry>): DirNode[] {
  const nodes = new Map<string, DirNode>();
  for (const e of entries) {
    if (e.dir === "") continue;
    const parts = e.dir.split("/");
    for (let d = 0; d < parts.length; d++) {
      const dir = parts.slice(0, d + 1).join("/");
      let node = nodes.get(dir);
      if (!node) {
        node = { dir, name: parts[d], depth: d, count: 0, total: 0 };
        nodes.set(dir, node);
      }
      node.total++;
      if (d === parts.length - 1) node.count++;
    }
  }
  // 逐段比较，保证子目录紧跟父目录（深度优先）
  return sortPaths([...nodes.keys()]).map((dir) => nodes.get(dir)!);
}
