import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { BatchSummary } from "../ipc/types";
import { formatBytes } from "../lib/formatBytes";
import { showToast, useToast } from "../stores/toast";
import { startBatchToast, summaryDetails, summaryText } from "./batchToast";

vi.mock("./fileOps", () => ({ undoLast: vi.fn() }));

const base: BatchSummary = { processed: 3, failed: [], skipped: [], savedBytes: 2048, token: 7, cancelled: false };
const cur = () => useToast.getState().current;

beforeEach(() => {
  vi.useFakeTimers();
  useToast.setState({ current: null });
});
afterEach(() => vi.useRealTimers());

describe("summaryText", () => {
  it("节省", () => {
    expect(summaryText(base)).toBe(t("batch.summary.saved", { n: 3, size: formatBytes(2048) }));
  });
  it("体积增加", () => {
    expect(summaryText({ ...base, savedBytes: -2048 })).toBe(t("batch.summary.larger", { n: 3, size: formatBytes(2048) }));
  });
  it("取消", () => {
    expect(summaryText({ ...base, cancelled: true })).toBe(t("batch.summary.cancelled", { n: 3 }));
  });
  it("带失败与跳过", () => {
    const s: BatchSummary = {
      ...base,
      failed: [{ id: 1, name: "a.jpg", reason: "decode" }],
      skipped: [{ id: 2, name: "b.gif", reason: "animated" }, { id: 3, name: "c.png", reason: "inOutput" }],
    };
    const sep = t("batch.summary.sep");
    expect(summaryText(s)).toBe(
      [t("batch.summary.saved", { n: 3, size: formatBytes(2048) }), t("batch.summary.failed", { f: 1 }), t("batch.summary.skipped", { s: 2 })].join(sep),
    );
  });
});

describe("summaryDetails", () => {
  it("失败在前，跳过在后，格式为 文件名：原因", () => {
    const s: BatchSummary = {
      ...base,
      failed: [{ id: 1, name: "a.jpg", reason: "decode" }],
      skipped: [{ id: 2, name: "b.gif", reason: "animated" }],
    };
    expect(summaryDetails(s)).toEqual([
      t("batch.detailLine", { name: "a.jpg", reason: t("batch.fail.decode") }),
      t("batch.detailLine", { name: "b.gif", reason: t("batch.skip.animated") }),
    ]);
  });
});

describe("startBatchToast", () => {
  const finished = { kind: "finished" as const, ...base };

  it("500 ms 前收到 finished 只出汇总，不出进度", () => {
    const on = startBatchToast({ total: 5, cancel: vi.fn() });
    on({ kind: "progress", done: 2, total: 5, failed: 0, savedBytes: 0 });
    vi.advanceTimersByTime(300);
    expect(cur()).toBeNull();
    on(finished);
    expect(cur()?.progress).toBeUndefined();
    expect(cur()?.text).toBe(summaryText(base));
    expect(cur()?.sticky).toBe(true);
    expect(cur()?.actions?.map((a) => a.label)).toEqual([t("fs.undo")]);
    vi.advanceTimersByTime(2000);
    expect(cur()?.progress).toBeUndefined();
    expect(cur()?.text).toBe(summaryText(base));
  });

  it("500 ms 后出进度形态：busy、取消按钮；之后的进度原地更新", () => {
    const cancel = vi.fn();
    const on = startBatchToast({ total: 5, cancel });
    on({ kind: "progress", done: 1, total: 5, failed: 0, savedBytes: 0 });
    vi.advanceTimersByTime(500);
    const first = cur();
    expect(first?.busy).toBe(true);
    expect(first?.progress).toEqual({ done: 1, total: 5 });
    expect(first?.text).toBe(t("batch.progress", { done: 1, total: 5 }));
    first?.actions?.[0]?.run();
    expect(cancel).toHaveBeenCalled();
    expect(first?.actions?.[0]?.label).toBe(t("batch.cancel"));
    on({ kind: "progress", done: 3, total: 5, failed: 0, savedBytes: 0 });
    expect(cur()?.key).toBe(first?.key);
    expect(cur()?.progress).toEqual({ done: 3, total: 5 });
  });

  it("进度条被别的提示替换后，下一次进度重新出现", () => {
    const on = startBatchToast({ total: 5, cancel: vi.fn() });
    vi.advanceTimersByTime(500);
    expect(cur()?.progress).toEqual({ done: 0, total: 5 });
    showToast({ text: "别的提示" });
    on({ kind: "progress", done: 2, total: 5, failed: 0, savedBytes: 0 });
    expect(cur()?.progress).toEqual({ done: 2, total: 5 });
    expect(cur()?.busy).toBe(true);
  });

  it("汇总：无产出不带撤销；有失败带详情；finished 之后的迟到进度被忽略", () => {
    const on = startBatchToast({ total: 2, cancel: vi.fn() });
    vi.advanceTimersByTime(500);
    on({
      kind: "finished", ...base, processed: 0, token: null,
      failed: [{ id: 1, name: "a.jpg", reason: "encode" }],
    });
    expect(cur()?.actions).toBeUndefined();
    expect(cur()?.details).toEqual([t("batch.detailLine", { name: "a.jpg", reason: t("batch.fail.encode") })]);
    on({ kind: "progress", done: 2, total: 2, failed: 1, savedBytes: 0 });
    expect(cur()?.progress).toBeUndefined();
  });
});
