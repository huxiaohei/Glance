import { t } from "../i18n";
import { fsRename, fsTrash, fsUndo } from "../ipc/api";
import type { FileId, FsErrorCode, OpKind, OpReport } from "../ipc/types";
import { useCatalog } from "../stores/catalog";
import { topView } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { showToast, withBusy, type ToastAction } from "../stores/toast";
import { activeView } from "./commands";
import { getImageList } from "./useImageList";

/** 操作对象：单张视图 → 正在显示的那张；网格 → 选中集合里当前列表可见的那些，按列表顺序。其余视图 → []。 */
export function opTargets(): FileId[] {
  const view = activeView();
  const ids = getImageList().ids;
  if (view === "single") {
    const top = topView();
    // 已不在列表里的图（刚被删或被筛掉）不再操作
    return top.kind === "single" && ids.includes(top.id) ? [top.id] : [];
  }
  if (view === "grid") {
    const sel = useSelection.getState().ids;
    return sel.size === 0 ? [] : ids.filter((id) => sel.has(id));
  }
  return [];
}

/** 调用之前取好文件名：操作成功后条目可能已被移除（事件可能先于应答到达）。 */
export function captureNames(ids: readonly FileId[]): Map<FileId, string> {
  const entries = useCatalog.getState().entries;
  const names = new Map<FileId, string>();
  for (const id of ids) {
    const e = entries.get(id);
    if (e) names.set(id, e.name);
  }
  return names;
}

export function errorText(code: FsErrorCode): string {
  return t(`fs.err.${code}`);
}

type NameOf = (id: FileId) => string;
/** 一种操作的提示文字：有成功项时的主文字，全部失败时的主文字。 */
interface KindTexts {
  done(r: OpReport, nameOf: NameOf): string;
  allFailed(r: OpReport, nameOf: NameOf): string;
}

const GENERIC: KindTexts = {
  done: (r) => t("fs.done", { n: r.done.length }),
  allFailed: (r) => t("fs.failMany", { m: r.failed.length }),
};

/** 各操作的文字；没有单独写的用通用文字。 */
const TEXTS: Partial<Record<OpKind, KindTexts>> = {
  trash: {
    done: (r, nameOf) =>
      r.done.length === 1 ? t("fs.trash.one", { name: nameOf(r.done[0]) }) : t("fs.trash.many", { n: r.done.length }),
    allFailed: (r, nameOf) =>
      r.failed.length === 1 ? t("fs.trash.failOne", { name: nameOf(r.failed[0].id) }) : t("fs.trash.failMany", { m: r.failed.length }),
  },
  // 名字取新名字：调用方通过 names 传入
  rename: {
    done: (r, nameOf) => t("fs.rename.done", { name: nameOf(r.done[0]) }),
    allFailed: GENERIC.allFailed,
  },
};

export interface ReportOpts {
  /** 给了且有冲突（exists）项时出现“保留两者”，以冲突项的 id 和本次的 token 调用 */
  retry?: (ids: FileId[], token: number | null) => void;
  /** 调用之前取好的文件名（captureNames）；没有的从当前条目里取 */
  names?: ReadonlyMap<FileId, string>;
}

/** 把一次操作的结果变成提示条。任务 7、8 复用。retry 存在且有冲突项时出现“保留两者”。 */
export function reportOp(r: OpReport, opts: ReportOpts = {}): void {
  const entries = useCatalog.getState().entries;
  const nameOf: NameOf = (id) => opts.names?.get(id) ?? entries.get(id)?.name ?? "";
  const texts = TEXTS[r.kind] ?? GENERIC;
  const m = r.failed.length;

  let text: string;
  if (r.done.length > 0) text = texts.done(r, nameOf) + (m > 0 ? t("fs.failedSuffix", { m }) : "");
  else if (m > 0) text = texts.allFailed(r, nameOf);
  else text = texts.done(r, nameOf);

  const actions: ToastAction[] = [];
  if (r.done.length > 0 && r.token !== null) actions.push({ label: t("fs.undo"), run: () => void undoLast() });
  const conflicts = r.failed.filter((f) => f.code === "exists").map((f) => f.id);
  const retry = opts.retry;
  if (retry && conflicts.length > 0) actions.push({ label: t("fs.keepBoth"), run: () => retry(conflicts, r.token) });

  const details = r.failed.map((f) => t("fs.detailLine", { name: nameOf(f.id), reason: errorText(f.code) }));
  showToast({
    text,
    ...(actions.length > 0 ? { actions } : {}),
    ...(details.length > 0 ? { details } : {}),
  });
}

/** 正在等待后端应答的文件操作数（重命名可能与之重叠，所以是计数）。有操作进行时新的删除、撤销直接忽略：选中要等应答后才变，重复发出同一批 id
 *  会全部失败，失败的提示还会盖掉成功的那条和它的撤销按钮。 */
let inFlight = 0;

export function isBusy(): boolean {
  return inFlight > 0;
}

/** 带加载提示调用后端；已有操作在进行时什么都不做，返回 null。调用本身出错（不是操作结果里的失败项）时
 *  提示“操作失败”并返回 null。 */
async function call<T>(busyText: string, work: () => Promise<T>): Promise<T | null> {
  if (inFlight > 0) return null;
  inFlight++;
  try {
    return await withBusy(busyText, work());
  } catch {
    showToast({ text: errorText("other") });
    return null;
  } finally {
    inFlight--;
  }
}

/** 把操作对象移到废纸篓，结果汇总成提示条。没有对象时什么都不做。 */
export async function trashTargets(): Promise<void> {
  const ids = opTargets();
  if (ids.length === 0) return;
  const names = captureNames(ids);
  const r = await call(t("fs.busy.trash"), () => fsTrash(ids));
  if (r) reportOp(r, { names });
}

/** 撤销最近一次文件操作。 */
export async function undoLast(): Promise<void> {
  const r = await call(t("fs.busy.undo"), () => fsUndo());
  if (!r) return;
  if (r.kind === null) showToast({ text: t("fs.undo.nothing") });
  else if (r.failed.length === 0) showToast({ text: t("fs.undo.done") });
  else showToast({ text: t("fs.undo.partial", { m: r.failed.length }), details: r.failed.map(errorText) });
}

/** 成功或名字没变返回 null；否则返回错误码，供输入框就地显示。成功时走 reportOp（带撤销）。空名字等同没变。 */
export async function renameTo(id: FileId, name: string): Promise<FsErrorCode | null> {
  if (name === "" || name === useCatalog.getState().entries.get(id)?.name) return null;
  // 不受“进行中”拦截（输入框自己防重复提交），但运行期间占住它，删除、撤销不会与之重叠
  let r: OpReport;
  inFlight++;
  try {
    r = await fsRename(id, name);
  } catch {
    return "other";
  } finally {
    inFlight--;
  }
  if (r.done.length === 0) return r.failed[0]?.code ?? "other";
  // 条目可能还没更新：提示里用新名字
  reportOp(r, { names: new Map([[id, name]]) });
  return null;
}
