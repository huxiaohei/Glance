import { create } from "zustand";
import { startBatchToast } from "../app/batchToast";
import { t } from "../i18n";
import { batchCancel, batchStart } from "../ipc/api";
import type { BatchError, BatchEvent, EditParams, FileId } from "../ipc/types";
import { showToast } from "./toast";

interface BatchState {
  /** 后端任务号；命令应答前为 null */
  job: number | null;
  progress: { done: number; total: number; failed: number } | null;
}

export const useBatch = create<BatchState>(() => ({ job: null, progress: null }));

/** 从调用 startBatch 到收到 finished（或启动失败）之间为真。 */
let running = false;

export function batchRunning(): boolean {
  return running;
}

function errorText(e: unknown): string {
  const code = e as BatchError;
  if (code === "busy") return t("batch.err.busy");
  if (code === "noRoot") return t("batch.err.noRoot");
  return t("batch.err.other");
}

/** 开始批量任务；失败（含已有任务在进行）时弹对应提示并返回 false。 */
export async function startBatch(ids: FileId[], params: EditParams): Promise<boolean> {
  if (running) {
    showToast({ text: t("batch.err.busy") });
    return false;
  }
  running = true;
  useBatch.setState({ job: null, progress: { done: 0, total: ids.length, failed: 0 } });
  let finished = false;
  const toastHandler = startBatchToast({ total: ids.length, cancel: cancelBatch });
  const onEvent = (e: BatchEvent) => {
    if (finished) return;
    if (e.kind === "progress") {
      useBatch.setState({ progress: { done: e.done, total: e.total, failed: e.failed } });
    } else {
      finished = true;
      running = false;
      useBatch.setState({ job: null, progress: null });
    }
    toastHandler(e);
  };
  try {
    const job = await batchStart(ids, params, onEvent);
    if (!finished) useBatch.setState({ job });
    return true;
  } catch (e) {
    running = false;
    useBatch.setState({ job: null, progress: null });
    toastHandler.abort();
    showToast({ text: errorText(e) });
    return false;
  }
}

export function cancelBatch(): void {
  const job = useBatch.getState().job;
  if (job === null) return;
  void batchCancel(job).catch(() => {});
}
