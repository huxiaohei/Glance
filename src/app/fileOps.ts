import { t } from "../i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clipboardCopyImage, clipboardCopyPaths, fsCopy, fsMove, fsRename, fsTrash, fsUndo, reveal } from "../ipc/api";
import type { Dest, FileId, FsErrorCode, OpKind, OpReport } from "../ipc/types";
import { lastSegment } from "../lib/lastSegment";
import { useCatalog } from "../stores/catalog";
import { topView } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { showToast, withBusy, type ToastAction } from "../stores/toast";
import { activeView } from "./commands";
import { askName } from "../views/common/NamePrompt";
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
  /** 有成功项又有失败项时接在主文字后面；不给则用通用的“，{m} 张失败” */
  suffix?(r: OpReport): string;
}

const GENERIC: KindTexts = {
  done: (r) => t("fs.done", { n: r.done.length }),
  allFailed: (r) => t("fs.failMany", { m: r.failed.length }),
};

/** 目标目录的最后一级名字；没有目录时为空 */
function dirName(dest: string | null): string {
  return dest ? lastSegment(dest) : "";
}

const isExists = (f: { code: FsErrorCode }) => f.code === "exists";

/** 移动与复制共用一套文字，只差动词 */
function transferTexts(one: "fs.movedOne" | "fs.copiedOne", many: "fs.moved" | "fs.copied", all: "fs.allExists" | "fs.allExistsCopy"): KindTexts {
  return {
    done: (r, nameOf) =>
      r.done.length === 1
        ? t(one, { name: nameOf(r.done[0]), dir: dirName(r.dest) })
        : t(many, { n: r.done.length, dir: dirName(r.dest) }),
    allFailed: (r) => (r.failed.every(isExists) ? t(all) : t("fs.failMany", { m: r.failed.length })),
    suffix: (r) => {
      const skipped = r.failed.filter(isExists).length;
      const other = r.failed.length - skipped;
      return (skipped > 0 ? t("fs.skippedExists", { m: skipped }) : "") + (other > 0 ? t("fs.failedSuffix", { m: other }) : "");
    },
  };
}

/** 各操作的文字；没有单独写的用通用文字。 */
const TEXTS: Partial<Record<OpKind, KindTexts>> = {
  trash: {
    done: (r, nameOf) =>
      r.done.length === 1 ? t("fs.trash.one", { name: nameOf(r.done[0]) }) : t("fs.trash.many", { n: r.done.length }),
    allFailed: (r, nameOf) =>
      r.failed.length === 1 ? t("fs.trash.failOne", { name: nameOf(r.failed[0].id) }) : t("fs.trash.failMany", { m: r.failed.length }),
  },
  move: transferTexts("fs.movedOne", "fs.moved", "fs.allExists"),
  copy: transferTexts("fs.copiedOne", "fs.copied", "fs.allExistsCopy"),
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
  if (r.done.length > 0) text = texts.done(r, nameOf) + (m > 0 ? (texts.suffix?.(r) ?? t("fs.failedSuffix", { m })) : "");
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
  else {
    const details = r.failed.map((f) => t("fs.detailLine", { name: f.name, reason: errorText(f.code) }));
    showToast({ text: t("fs.undo.partial", { m: r.failed.length }), details });
  }
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

export type TransferKind = "move" | "copy";

const TRANSFER = {
  move: { run: fsMove, busy: "fs.busy.move", pick: "fs.pick.move" },
  copy: { run: fsCopy, busy: "fs.busy.copy", pick: "fs.pick.copy" },
} as const;

export interface Captured {
  ids: FileId[];
  names: Map<FileId, string>;
}

/** 对话框、输入框打开之前取好对象与文件名：它们打开期间选中、当前图、视图都可能变，移动的必须是用户发起时看到的那批 */
function captureTargets(): Captured {
  const ids = opTargets();
  return { ids, names: captureNames(ids) };
}

/** 选目录对话框或名称输入框正在等用户（同一时间只允许一个） */
let prompting = false;

/** 把操作对象移动或复制到 dest，结果汇总成提示条。没有对象时什么都不做。重名的先跳过，提示条上可“保留两者”。 */
export async function transferTo(kind: TransferKind, dest: Dest, captured?: Captured): Promise<void> {
  const { ids, names } = captured ?? captureTargets();
  if (ids.length === 0) return;
  const { run, busy } = TRANSFER[kind];
  const r = await call(t(busy), () => run(ids, dest, "skip"));
  if (!r) return;
  // 保留两者：同一个目标（新建的子目录此时已存在，改用它的实际路径）、同一个 token，只带冲突项；同样不与其他操作重叠
  const retry = (conflictIds: FileId[], token: number | null) => {
    const to: Dest = r.dest !== null ? { kind: "path", path: r.dest } : dest;
    void call(t(busy), () => run(conflictIds, to, "keepBoth", token ?? undefined)).then((r2) => {
      if (r2) reportOp(r2, { names });
    });
  };
  reportOp(r, { names, retry });
}

/** 弹系统的选目录对话框（默认位置是当前根目录），取消则不做事。对象在弹出之前取定。 */
export async function pickAndTransfer(kind: TransferKind): Promise<void> {
  if (prompting || isBusy()) return;
  const captured = captureTargets();
  if (captured.ids.length === 0) return;
  prompting = true;
  let picked: Awaited<ReturnType<typeof openDialog>>;
  try {
    picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: useCatalog.getState().root?.path,
      title: t(TRANSFER[kind].pick),
    });
  } catch {
    showToast({ text: errorText("other") });
    return;
  } finally {
    prompting = false;
  }
  if (typeof picked !== "string") return;
  await transferTo(kind, { kind: "path", path: picked }, captured);
}

/** 弹出名称输入框，确定后移动或复制到当前根目录下以此命名的子目录（不存在则由后端新建）。对象在弹出之前取定。 */
export async function transferToNewChild(kind: TransferKind): Promise<void> {
  if (prompting || isBusy()) return;
  const captured = captureTargets();
  if (captured.ids.length === 0) return;
  prompting = true;
  let name: string | null;
  try {
    name = await askName({ title: t("fs.newDir.title"), confirm: t("fs.newDir.confirm") });
  } finally {
    prompting = false;
  }
  if (name === null) return;
  await transferTo(kind, { kind: "newChild", name }, captured);
}

const ERROR_CODES: readonly FsErrorCode[] = [
  "notFound", "exists", "invalidName", "readOnly", "diskFull", "denied", "restoreDenied", "notInTrash", "tooLarge", "other",
];

/** 后端以错误码字符串拒绝；认不出的一律当作 other。 */
function codeOf(err: unknown): FsErrorCode {
  return ERROR_CODES.find((c) => c === err) ?? "other";
}

/** 很快的系统操作：不走“进行中”计数，失败时提示原因。 */
async function quick(work: () => Promise<void>, doneText: string | null): Promise<void> {
  try {
    await work();
  } catch (err) {
    showToast({ text: errorText(codeOf(err)) });
    return;
  }
  if (doneText !== null) showToast({ text: doneText });
}

/** 把操作对象的第一张复制到剪贴板（像素）。没有对象时什么都不做。 */
export async function copyImage(): Promise<void> {
  const [id] = opTargets();
  if (id === undefined) return;
  await quick(() => clipboardCopyImage(id), t("fs.copiedImage"));
}

/** 把全部操作对象的路径复制到剪贴板，一行一个。没有对象时什么都不做。 */
export async function copyPaths(): Promise<void> {
  const ids = opTargets();
  if (ids.length === 0) return;
  const text = ids.length === 1 ? t("fs.copiedPath") : t("fs.copiedPaths", { n: ids.length });
  await quick(() => clipboardCopyPaths(ids), text);
}

/** 在访达 / 资源管理器里选中操作对象的第一张；成功时不提示。 */
export async function revealFirst(): Promise<void> {
  const [id] = opTargets();
  if (id === undefined) return;
  await quick(() => reveal(id), null);
}
