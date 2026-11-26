import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { batchCancel, batchStart } from "../ipc/api";
import type { BatchEvent, EditParams } from "../ipc/types";
import { batchRunning, cancelBatch, startBatch, useBatch } from "./batch";
import { useToast } from "./toast";

vi.mock("../ipc/api", () => ({ batchStart: vi.fn(), batchCancel: vi.fn() }));
vi.mock("../app/fileOps", () => ({ undoLast: vi.fn() }));

const params = {} as EditParams;
let emit: (e: BatchEvent) => void;

beforeEach(() => {
  vi.useFakeTimers();
  useToast.setState({ current: null });
  useBatch.setState({ job: null, progress: null });
  vi.mocked(batchStart).mockReset();
  vi.mocked(batchCancel).mockReset().mockResolvedValue(undefined);
  vi.mocked(batchStart).mockImplementation(async (_ids, _p, on) => {
    emit = on;
    return 42;
  });
});

afterEach(() => {
  if (batchRunning()) emit(fin);
  vi.useRealTimers();
});

const fin = { kind: "finished" as const, processed: 1, failed: [], skipped: [], savedBytes: 10, token: 1, cancelled: false };

describe("batch store", () => {
  it("startBatch 期间 batchRunning 为真，finished 后为假", async () => {
    expect(batchRunning()).toBe(false);
    expect(await startBatch([1, 2], params)).toBe(true);
    expect(batchRunning()).toBe(true);
    expect(useBatch.getState().job).toBe(42);
    emit({ kind: "progress", done: 1, total: 2, failed: 0, savedBytes: 0 });
    expect(useBatch.getState().progress).toEqual({ done: 1, total: 2, failed: 0 });
    emit(fin);
    expect(batchRunning()).toBe(false);
    expect(useBatch.getState().job).toBeNull();
    expect(useBatch.getState().progress).toBeNull();
  });

  it("finished 先于命令应答到达也能复位", async () => {
    vi.mocked(batchStart).mockImplementation(async (_i, _p, on) => {
      on(fin);
      return 9;
    });
    expect(await startBatch([1], params)).toBe(true);
    expect(batchRunning()).toBe(false);
    expect(useBatch.getState().job).toBeNull();
  });

  it("busy 错误弹提示并返回 false", async () => {
    vi.mocked(batchStart).mockRejectedValue("busy");
    expect(await startBatch([1], params)).toBe(false);
    expect(useToast.getState().current?.text).toBe(t("batch.err.busy"));
    expect(batchRunning()).toBe(false);
  });

  it("noRoot 与其他错误各有提示", async () => {
    vi.mocked(batchStart).mockRejectedValue("noRoot");
    await startBatch([1], params);
    expect(useToast.getState().current?.text).toBe(t("batch.err.noRoot"));
    vi.mocked(batchStart).mockRejectedValue("invalid");
    await startBatch([1], params);
    expect(useToast.getState().current?.text).toBe(t("batch.err.other"));
  });

  it("已在进行时再开始：不调后端，弹 busy 提示", async () => {
    await startBatch([1], params);
    expect(await startBatch([2], params)).toBe(false);
    expect(batchStart).toHaveBeenCalledTimes(1);
    expect(useToast.getState().current?.text).toBe(t("batch.err.busy"));
  });

  it("cancelBatch 调后端取消当前任务；没任务时什么都不做", async () => {
    cancelBatch();
    expect(batchCancel).not.toHaveBeenCalled();
    await startBatch([1], params);
    cancelBatch();
    expect(batchCancel).toHaveBeenCalledWith(42);
  });
});
