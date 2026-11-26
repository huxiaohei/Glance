// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { activeView } from "../../app/commands";
import { enterBatch, exitBatch } from "../../app/batchMode";
import { t } from "../../i18n";
import {
  appVersion, basketRestore, batchPlan, batchStart, editClose, editOpen, editParamsGet, editParamsSet, editPreview,
  editResultUrl, onOpenRequest, takeOpenRequest, thumbsSubscribe, thumbsWant, updateCheck,
} from "../../ipc/api";
import type { BatchPlan, EditOpened, FileId } from "../../ipc/types";
import { useAnimated } from "../../stores/animated";
import { useCatalog } from "../../stores/catalog";
import { useEditUi } from "../../stores/editUi";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import { useToast } from "../../stores/toast";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

let restore: (() => void)[] = [];
const stubSize = (prop: "clientWidth" | "clientHeight", value: number) => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
  Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => value });
  restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
};

let session = 0;
const opened = (): EditOpened => ({
  session: ++session, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000,
});
const allProcess = async (ids: FileId[]): Promise<BatchPlan> => ({ process: [...ids], skipped: [] });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(takeOpenRequest).mockResolvedValue(null);
  vi.mocked(basketRestore).mockResolvedValue([]);
  vi.mocked(updateCheck).mockResolvedValue(null);
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(onOpenRequest).mockResolvedValue(() => {});
  vi.mocked(thumbsWant).mockResolvedValue([]);
  vi.mocked(editParamsGet).mockRejectedValue("none");
  vi.mocked(editParamsSet).mockResolvedValue();
  vi.mocked(editOpen).mockImplementation(async () => opened());
  vi.mocked(editClose).mockResolvedValue();
  vi.mocked(editPreview).mockImplementation(async (_s, rev) => ({
    rev, bytes: 10, approx: false, format: "jpeg", width: 100, height: 50,
  }));
  vi.mocked(editResultUrl).mockImplementation((s, r) => `glance://localhost/edit/${s}/${r}`);
  vi.mocked(batchPlan).mockImplementation(allProcess);
  vi.mocked(batchStart).mockResolvedValue(7);
  stubSize("clientWidth", 600);
  stubSize("clientHeight", 400);
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  restore.push(() =>
    desc ? Object.defineProperty(HTMLImageElement.prototype, "decode", desc) : delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode,
  );
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
  useToast.setState({ current: null });
  useAnimated.setState({ ids: new Set() });
});
afterEach(() => {
  act(() => exitBatch());
  useEditUi.getState().close();
  vi.mocked(editOpen).mockClear();
  vi.mocked(editClose).mockClear();
  vi.mocked(batchPlan).mockClear();
  vi.mocked(batchStart).mockClear();
  vi.mocked(editParamsSet).mockClear();
  for (const r of restore) r();
  restore = [];
});

const add = (...ids: number[]) => {
  act(() => {
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: ids.map((id) => ({ id, size: 1, mtimeMs: 1, relPath: `${id}.jpg` })),
    });
  });
};
const key = (k: string, o: Partial<KeyboardEventInit> = {}) => {
  act(() => {
    fireEvent.keyDown(document.body, { key: k, ...o });
  });
};
const settle = () => act(async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
});

/** 打开目录（1..5 号图），选中 [1,3,5]，焦点 3，进入批量模式。 */
async function startBatchMode(tab: "compress" | "convert" = "compress") {
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
  });
  const r = render(<App />);
  add(1, 2, 3, 4, 5);
  act(() => useSelection.getState().set({ ids: new Set([1, 3, 5]), focus: 3, anchor: 3 }));
  await settle();
  // 不等它返回：清单可能被测试故意压着
  act(() => void enterBatch([1, 3, 5], 3, tab));
  await settle();
  return r;
}

const tabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>(".edit-panel [role=tab]")];
const primary = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".edit-panel .edit-primary")!;

describe("批量模式", () => {
  it("shows_only_two_tabs_in_batch", async () => {
    const { container } = await startBatchMode();
    expect(activeView()).toBe("edit");
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 3 });
    expect(tabs(container).map((b) => b.textContent)).toEqual([t("edit.tab.compress"), t("edit.tab.convert")]);
    expect(useEditUi.getState().tab).toBe("compress");
    // 没有下拉、没有覆盖与另存
    expect(container.querySelector(".edit-panel .edit-more")).toBeNull();
  });

  it("arrows_cycle_within_selection", async () => {
    await startBatchMode("convert");
    expect(editOpen).toHaveBeenLastCalledWith(3);
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 5 });
    expect(editOpen).toHaveBeenLastCalledWith(5);
    expect(useEditUi.getState()).toMatchObject({ id: 5, tab: "convert", status: "ready" });
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 1 });
    expect(editOpen).toHaveBeenLastCalledWith(1);
    expect(useEditUi.getState()).toMatchObject({ id: 1, tab: "convert" });
    key("ArrowLeft");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 5 });
  });

  it("keeps_adjusted_params_when_stepping", async () => {
    await startBatchMode();
    act(() => useEditUi.getState().patch("compress", { quality: 40 }));
    key("ArrowRight");
    await settle();
    expect(useEditUi.getState().compress.quality).toBe(40);
  });

  it("arrows_do_nothing_in_single_edit", async () => {
    act(() => {
      useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    });
    render(<App />);
    add(1, 2, 3);
    act(() => useNav.getState().openSingle(2));
    await settle();
    key("e");
    await settle();
    expect(activeView()).toBe("edit");
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    expect(editOpen).toHaveBeenCalledTimes(1);
  });

  it("save_button_shows_count_and_disables_at_zero", async () => {
    const first = deferred<BatchPlan>();
    vi.mocked(batchPlan).mockImplementationOnce(() => first.promise);
    const { container } = await startBatchMode();
    // 计划未到：“处理…”禁用
    expect(primary(container).textContent).toBe(t("edit.batch.processPending"));
    expect(primary(container).disabled).toBe(true);
    await act(async () => first.resolve({ process: [1, 3], skipped: [{ id: 5, name: "5.jpg", reason: "inOutput" }] }));
    await settle();
    expect(primary(container).textContent).toBe(t("edit.batch.process", { n: 2 }));
    expect(primary(container).disabled).toBe(false);
    expect(container.querySelector(".edit-batch-counts")?.textContent).toBe(t("edit.batch.counts", { n: 2, m: 1 }));
    // 切到转格式后一张都不处理：禁用
    vi.mocked(batchPlan).mockResolvedValueOnce({
      process: [], skipped: [1, 3, 5].map((id) => ({ id, name: `${id}.jpg`, reason: "unsupported" as const })),
    });
    act(() => fireEvent.click(tabs(container)[1]));
    await settle();
    expect(primary(container).textContent).toBe(t("edit.batch.process", { n: 0 }));
    expect(primary(container).disabled).toBe(true);
    key("Enter");
    await settle();
    expect(batchStart).not.toHaveBeenCalled();
  });

  it("skipped_image_shows_reason_and_stays", async () => {
    vi.mocked(editOpen).mockImplementation(async (id) => {
      if (id === 3) throw "animated";
      return opened();
    });
    vi.mocked(batchPlan).mockResolvedValue({ process: [1, 5], skipped: [{ id: 3, name: "3.jpg", reason: "animated" }] });
    const { container } = await startBatchMode();
    expect(useToast.getState().current).toBeNull();
    expect(useEditUi.getState().batch).not.toBeNull();
    expect(activeView()).toBe("edit");
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 3 });
    const note = container.querySelector(".edit-batch-skip");
    expect(note?.textContent).toBe(t("edit.batch.skipThis", { reason: t("batch.skip.animated") }));
    // 参数仍可调，仍可切图
    expect(tabs(container)).toHaveLength(2);
    act(() => useEditUi.getState().patch("compress", { quality: 50 }));
    expect(useEditUi.getState().compress.quality).toBe(50);
    expect(primary(container).textContent).toBe(t("edit.batch.process", { n: 2 }));
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 5 });
    expect(useEditUi.getState().status).toBe("ready");
    expect(container.querySelector(".edit-batch-skip")).toBeNull();
  });

  it("slow_older_open_does_not_mark_wrong_image_animated", async () => {
    // 5 号图（A）解码慢，1 号图（B）是动图、很快失败：A 的打开在 B 之后才结束，不能把 B 的失败算到 A 头上
    const slowA = deferred<EditOpened>();
    let rejectB!: (e: unknown) => void;
    const failB = new Promise<EditOpened>((_, rej) => (rejectB = rej));
    vi.mocked(editOpen).mockImplementation((id) => {
      if (id === 5) return slowA.promise;
      if (id === 1) return failB;
      return Promise.resolve(opened());
    });
    await startBatchMode();
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 5 });
    key("ArrowRight");
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 1 });
    // B 先失败（动图），A 随后才解码完
    await act(async () => rejectB("animated"));
    await settle();
    await act(async () => slowA.resolve(opened()));
    await settle();
    expect(useAnimated.getState().ids.has(1)).toBe(true);
    expect(useAnimated.getState().ids.has(5)).toBe(false);
    expect(useToast.getState().current).toBeNull();
  });

  it("tab_switch_refreshes_plan", async () => {
    const late = deferred<BatchPlan>();
    vi.mocked(batchPlan).mockImplementationOnce(() => late.promise);
    const { container } = await startBatchMode();
    expect(batchPlan).toHaveBeenLastCalledWith([1, 3, 5], "compress");
    const convertPlan: BatchPlan = { process: [1], skipped: [] };
    vi.mocked(batchPlan).mockResolvedValueOnce(convertPlan);
    act(() => fireEvent.click(tabs(container)[1]));
    await settle();
    expect(useEditUi.getState().tab).toBe("convert");
    expect(batchPlan).toHaveBeenLastCalledWith([1, 3, 5], "convert");
    expect(useEditUi.getState().batch?.plan).toEqual(convertPlan);
    // 迟到的压缩结果被丢弃
    await act(async () => late.resolve({ process: [1, 3, 5], skipped: [] }));
    await settle();
    expect(useEditUi.getState().batch?.plan).toEqual(convertPlan);
  });

  it("enter_starts_and_returns_to_grid", async () => {
    await startBatchMode();
    act(() => useEditUi.getState().patch("compress", { quality: 60 }));
    key("Enter");
    await settle();
    expect(batchStart).toHaveBeenCalledWith(
      [1, 3, 5],
      { op: "compress", quality: 60, maxEdge: null, pngMode: "lossy" },
      expect.any(Function),
    );
    expect(editParamsSet).toHaveBeenCalledWith(expect.objectContaining({ tab: "compress", compress: expect.objectContaining({ quality: 60 }) }));
    expect(topView()).toEqual({ kind: "grid" });
    expect(useEditUi.getState().batch).toBeNull();
    expect(useEditUi.getState().status).toBe("idle");
    expect(activeView()).toBe("grid");
    expect([...useSelection.getState().ids]).toEqual([1, 3, 5]);
  });

  it("esc_returns_to_grid_keeping_selection", async () => {
    await startBatchMode();
    key("Escape");
    await settle();
    expect(topView()).toEqual({ kind: "grid" });
    expect(useEditUi.getState().batch).toBeNull();
    expect(useEditUi.getState().status).toBe("idle");
    expect(batchStart).not.toHaveBeenCalled();
    expect([...useSelection.getState().ids]).toEqual([1, 3, 5]);
    expect(useSelection.getState().focus).toBe(3);
  });

  it("focus_outside_ids_falls_back_to_first", async () => {
    act(() => {
      useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    });
    render(<App />);
    add(1, 2, 3);
    await act(() => enterBatch([1, 3], 2, "compress"));
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "selection", id: 1 });
  });
});
