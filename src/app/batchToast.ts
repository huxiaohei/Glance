import { t } from "../i18n";
import type { BatchEvent, BatchSummary, FailReason, SkipReason } from "../ipc/types";
import { formatBytes } from "../lib/formatBytes";
import { showToast, updateToast, type ToastSpec } from "../stores/toast";
import { undoLast } from "./fileOps";

/** 任务开始这么久还没结束，才出现进度形态的提示条。 */
const PROGRESS_DELAY_MS = 500;

export function summaryText(s: BatchSummary): string {
  let head: string;
  if (s.cancelled) head = t("batch.summary.cancelled", { n: s.processed });
  else if (s.savedBytes < 0) head = t("batch.summary.larger", { n: s.processed, size: formatBytes(-s.savedBytes) });
  else head = t("batch.summary.saved", { n: s.processed, size: formatBytes(s.savedBytes) });
  const parts = [head];
  if (s.failed.length > 0) parts.push(t("batch.summary.failed", { f: s.failed.length }));
  if (s.skipped.length > 0) parts.push(t("batch.summary.skipped", { s: s.skipped.length }));
  return parts.join(t("batch.summary.sep"));
}

const FAIL_KEYS = {
  notFound: "batch.fail.notFound",
  decode: "batch.fail.decode",
  tooLarge: "batch.fail.tooLarge",
  encode: "batch.fail.encode",
  readOnly: "batch.fail.readOnly",
  diskFull: "batch.fail.diskFull",
  denied: "batch.fail.denied",
  noCodec: "batch.fail.noCodec",
  other: "batch.fail.other",
} as const satisfies Record<FailReason, string>;

const SKIP_KEYS = {
  unsupported: "batch.skip.unsupported",
  animated: "batch.skip.animated",
  inOutput: "batch.skip.inOutput",
  notFound: "batch.skip.notFound",
  noCodec: "batch.skip.noCodec",
} as const satisfies Record<SkipReason, string>;

/** 跳过原因的文字（批量模式面板里的“这张会被跳过”也用它）。 */
export function skipReasonText(reason: SkipReason): string {
  return t(SKIP_KEYS[reason]);
}

/** 失败在前、跳过在后，每行“文件名：原因”。 */
export function summaryDetails(s: BatchSummary): string[] {
  return [
    ...s.failed.map((f) => t("batch.detailLine", { name: f.name, reason: t(FAIL_KEYS[f.reason]) })),
    ...s.skipped.map((k) => t("batch.detailLine", { name: k.name, reason: skipReasonText(k.reason) })),
  ];
}

export interface BatchToastHandler {
  (e: BatchEvent): void;
  /** 启动失败：停掉计时器，之后的事件一律忽略。 */
  abort(): void;
}

/** 提示条驱动：返回的函数挂到批量事件上。开始后 500 ms 仍未结束才显示进度形态。 */
export function startBatchToast(opts: { total: number; cancel(): void }): BatchToastHandler {
  let done = 0;
  let total = opts.total;
  let key: number | null = null;
  let over = false;

  const spec = (): ToastSpec => ({
    text: t("batch.progress", { done, total }),
    progress: { done, total },
    busy: true,
    actions: [{ label: t("batch.cancel"), run: opts.cancel, keep: true }],
  });
  const render = () => {
    if (key !== null && updateToast(key, spec())) return;
    key = showToast(spec());
  };

  const timer = setTimeout(() => {
    if (!over) render();
  }, PROGRESS_DELAY_MS);

  const handler = ((e: BatchEvent) => {
    if (over) return;
    if (e.kind === "progress") {
      done = e.done;
      total = e.total;
      if (key !== null) render();
      return;
    }
    over = true;
    clearTimeout(timer);
    const details = summaryDetails(e);
    showToast({
      text: summaryText(e),
      sticky: true,
      ...(e.processed > 0 && e.token !== null ? { actions: [{ label: t("fs.undo"), run: () => void undoLast() }] } : {}),
      ...(details.length > 0 ? { details } : {}),
    });
  }) as BatchToastHandler;
  handler.abort = () => {
    over = true;
    clearTimeout(timer);
  };
  return handler;
}
