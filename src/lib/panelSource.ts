import type { FileId } from "../ipc/types";
import type { BasketItem } from "./basket";
import { deriveList, type DirNode, type ImageEntry, type SortKey } from "./deriveList";
import { naturalCompare } from "./naturalCompare";

/** 添加面板的来源：当前文件夹、它的某个子目录（相对根），或用对话框选的其他文件夹（条目快照）。 */
export type PanelSource =
  | { kind: "root" }
  | { kind: "dir"; dir: string }
  | { kind: "other"; name: string; items: BasketItem[] };

export interface PanelOption { key: string; label: string; depth: number; count: number }

/** 来源选项在下拉里的键。 */
export function panelKey(s: PanelSource): string {
  return s.kind === "dir" ? `dir:${s.dir}` : s.kind;
}

/**
 * 来源下拉的选项（“其他文件夹…”那项不在其中）：当前文件夹（label 为空，由界面填）、
 * 目录树里的各子目录（depth 从 1 起，count 取节点的 total）、最近一次选的其他文件夹。
 */
export function panelOptions(
  tree: DirNode[],
  rootCount: number,
  other: { name: string; count: number } | null,
): PanelOption[] {
  const out: PanelOption[] = [{ key: "root", label: "", depth: 0, count: rootCount }];
  for (const n of tree) out.push({ key: `dir:${n.dir}`, label: n.name, depth: n.depth + 1, count: n.total });
  if (other) out.push({ key: "other", label: other.name, depth: 0, count: other.count });
  return out;
}

/** 面板列出的图：root / dir 用网格的排序与包含子目录派生（不折叠）；other 按文件名自然序。 */
export function panelIds(
  entries: ReadonlyMap<FileId, ImageEntry>,
  sort: SortKey,
  includeSubdirs: boolean,
  source: PanelSource,
): FileId[] {
  if (source.kind === "other") {
    return [...source.items].sort((a, b) => naturalCompare(a.name, b.name)).map((it) => it.id);
  }
  const dirFilter = source.kind === "dir" ? source.dir : null;
  return deriveList(entries.values(), { sort, includeSubdirs, dirFilter, collapsed: new Set() }).ids;
}

/** 来源为子目录时，它在当前条目里是否还有图（含下级）。 */
export function dirExists(entries: ReadonlyMap<FileId, ImageEntry>, dir: string): boolean {
  const prefix = dir + "/";
  for (const e of entries.values()) if (e.dir === dir || e.dir.startsWith(prefix)) return true;
  return false;
}
