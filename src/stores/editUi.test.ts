import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditOpened, EditParams, EditParamsMemory, PreviewResult } from "../ipc/types";

const editOpen = vi.fn<(id: number) => Promise<EditOpened>>();
const editPreview = vi.fn<(s: number, rev: number, p: EditParams, full: boolean) => Promise<PreviewResult | null>>();
const editClose = vi.fn<(s: number) => Promise<void>>();
const editParamsGet = vi.fn<() => Promise<EditParamsMemory>>();
const editParamsSet = vi.fn<(p: EditParamsMemory) => Promise<void>>();
vi.mock("../ipc/api", () => ({
  editOpen: (id: number) => editOpen(id),
  editPreview: (s: number, r: number, p: EditParams, f: boolean) => editPreview(s, r, p, f),
  editClose: (s: number) => editClose(s),
  editParamsGet: () => editParamsGet(),
  editParamsSet: (p: EditParamsMemory) => editParamsSet(p),
  editResultUrl: (s: number, r: number) => `u/${s}/${r}`,
}));

const { useEditUi, currentParams } = await import("./editUi");

const memory = (tab: "compress" | "convert" = "compress"): EditParamsMemory => ({
  tab,
  compress: { quality: 70, maxEdgeOn: true, maxEdge: 1600, pngMode: "lossy" },
  convert: { format: "jpeg", quality: 85, fill: [255, 255, 255] },
});
const opened = (session: number, srcFormat: EditOpened["srcFormat"] = "jpeg"): EditOpened => ({
  session, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat, hasAlpha: false, fileSize: 1000,
});
const prev = (rev: number): PreviewResult => ({ rev, bytes: 10, approx: false, format: "jpeg", width: 100, height: 50 });

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of [editOpen, editPreview, editClose, editParamsGet, editParamsSet]) m.mockReset();
  editClose.mockResolvedValue();
  editParamsSet.mockResolvedValue();
  editPreview.mockImplementation(async (_s, rev) => prev(rev));
  useEditUi.getState().close();
  editClose.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useEditUi", () => {
  it("open_loads_memory_and_falls_back_tab", async () => {
    editParamsGet.mockResolvedValue(memory("compress"));
    editOpen.mockResolvedValue(opened(1, "gif"));
    await useEditUi.getState().open(7);
    const s = useEditUi.getState();
    expect(s.status).toBe("ready");
    expect(s.id).toBe(7);
    expect(s.tab).toBe("convert");
    expect(s.compress.quality).toBe(70);
    s.close();
  });

  it("open_keeps_remembered_tab_for_jpeg", async () => {
    editParamsGet.mockResolvedValue(memory("compress"));
    editOpen.mockResolvedValue(opened(1, "jpeg"));
    await useEditUi.getState().open(7);
    expect(useEditUi.getState().tab).toBe("compress");
    useEditUi.getState().close();
  });

  it("close_calls_edit_close_once", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValue(opened(5));
    await useEditUi.getState().open(7);
    useEditUi.getState().close();
    useEditUi.getState().close();
    expect(editClose).toHaveBeenCalledTimes(1);
    expect(editClose).toHaveBeenCalledWith(5);
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("open_closes_previous_session_first", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValueOnce(opened(1)).mockResolvedValueOnce(opened(2));
    await useEditUi.getState().open(7);
    await useEditUi.getState().open(8);
    expect(editClose).toHaveBeenCalledWith(1);
    expect(useEditUi.getState().opened?.session).toBe(2);
    useEditUi.getState().close();
  });

  it("open_failure_sets_error_and_idle", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockRejectedValue("animated");
    await useEditUi.getState().open(7);
    expect(useEditUi.getState().status).toBe("idle");
    expect(useEditUi.getState().error).toBe("animated");
  });

  it("preview_result_sets_url_and_ignores_old_session", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValue(opened(3));
    await useEditUi.getState().open(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditUi.getState().resultUrl).toBe("u/3/1");
    useEditUi.getState().close();
    expect(useEditUi.getState().resultUrl).toBeNull();
  });

  it("patch_triggers_preview_with_params", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValue(opened(3));
    await useEditUi.getState().open(7);
    await vi.advanceTimersByTimeAsync(300);
    editPreview.mockClear();
    useEditUi.getState().patch("compress", { quality: 50 });
    expect(editPreview).toHaveBeenCalledWith(3, 3, { op: "compress", quality: 50, maxEdge: 1600, pngMode: "lossy" }, false);
    useEditUi.getState().close();
  });

  it("cancel_does_not_write_memory", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValue(opened(3, "gif"));
    await useEditUi.getState().open(7);
    useEditUi.getState().patch("convert", { quality: 60 });
    useEditUi.getState().close();
    expect(editParamsSet).not.toHaveBeenCalled();
  });

  it("commit_memory_writes_current_params", async () => {
    editParamsGet.mockResolvedValue(memory());
    editOpen.mockResolvedValue(opened(3));
    await useEditUi.getState().open(7);
    useEditUi.getState().setTab("convert");
    await useEditUi.getState().commitMemory();
    expect(editParamsSet).toHaveBeenCalledWith(expect.objectContaining({ tab: "convert" }));
    useEditUi.getState().close();
  });
});

describe("currentParams", () => {
  it("maps compress memory, max edge off -> null", () => {
    const m = memory();
    const base = { tab: "compress" as const, compress: { ...m.compress, maxEdgeOn: false }, convert: m.convert };
    expect(currentParams(base)).toEqual({ op: "compress", quality: 70, maxEdge: null, pngMode: "lossy" });
    expect(currentParams({ ...base, tab: "convert" })).toEqual({ op: "convert", format: "jpeg", quality: 85, fill: [255, 255, 255] });
  });
});
