import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditOpened, EditParams, EditParamsMemory, PreviewResult } from "../ipc/types";

const editOpen = vi.fn<(id: number) => Promise<EditOpened>>();
const editPreview = vi.fn<(s: number, rev: number, p: EditParams, full: boolean) => Promise<PreviewResult | null>>();
const editClose = vi.fn<(s: number) => Promise<void>>();
const editParamsGet = vi.fn<() => Promise<EditParamsMemory>>();
const editPick = vi.fn<(s: number, x: number, y: number) => Promise<[number, number, number]>>();
const editParamsSet = vi.fn<(p: EditParamsMemory) => Promise<void>>();
vi.mock("../ipc/api", () => ({
  editOpen: (id: number) => editOpen(id),
  editPreview: (s: number, r: number, p: EditParams, f: boolean) => editPreview(s, r, p, f),
  editClose: (s: number) => editClose(s),
  editParamsGet: () => editParamsGet(),
  editParamsSet: (p: EditParamsMemory) => editParamsSet(p),
  editPick: (s: number, x: number, y: number) => editPick(s, x, y),
  editResultUrl: (s: number, r: number) => `u/${s}/${r}`,
}));

const { useEditUi, currentParams, cropIsIdentity } = await import("./editUi");

const memory = (tab: EditParamsMemory["tab"] = "compress"): EditParamsMemory => ({
  tab,
  crop: { ratio: "free", customW: 3, customH: 2, portrait: false },
  removeBg: { mode: "color", threshold: 16, below: true, tolerance: 10, softness: 10, edgeConnected: true },
  compress: { quality: 70, maxEdgeOn: true, maxEdge: 1600, pngMode: "lossy" },
  convert: { format: "jpeg", quality: 85, fill: [255, 255, 255] },
});
const opened = (session: number, srcFormat: EditOpened["srcFormat"] = "jpeg"): EditOpened => ({
  session, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat, hasAlpha: false, fileSize: 1000,
});
const prev = (rev: number): PreviewResult => ({ rev, bytes: 10, approx: false, format: "jpeg", width: 100, height: 50 });

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of [editOpen, editPreview, editClose, editParamsGet, editParamsSet, editPick]) m.mockReset();
  editPick.mockResolvedValue([255, 255, 255]);
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
    const base = {
      tab: "compress" as const, compress: { ...m.compress, maxEdgeOn: false }, convert: m.convert,
      crop: m.crop, removeBg: m.removeBg, cropState: null, bgColor: null,
    };
    expect(currentParams(base)).toEqual({ op: "compress", quality: 70, maxEdge: null, pngMode: "lossy" });
    expect(currentParams({ ...base, tab: "convert" })).toEqual({ op: "convert", format: "jpeg", quality: 85, fill: [255, 255, 255] });
  });
});

const full = { x: 0, y: 0, w: 100, h: 50 };
const openOn = async (tab: EditParamsMemory["tab"], over: Partial<EditParamsMemory> = {}, o = opened(3)) => {
  editParamsGet.mockResolvedValue({ ...memory(tab), ...over });
  editOpen.mockResolvedValue(o);
  await useEditUi.getState().open(7);
  await vi.advanceTimersByTimeAsync(300);
};

describe("crop and removeBg state", () => {
  it("open_initialises_crop_state_and_bg_color", async () => {
    editPick.mockResolvedValue([1, 2, 3]);
    await openOn("compress");
    const s = useEditUi.getState();
    expect(s.cropState).toEqual({ rect: full, quarterTurns: 0, flipH: false, flipV: false });
    expect(s.bgColor).toEqual([1, 2, 3]);
    expect(editPick).toHaveBeenCalledWith(3, 0, 0);
    s.close();
  });

  it("pick_failure_falls_back_to_white", async () => {
    editPick.mockRejectedValue("invalid");
    await openOn("compress");
    expect(useEditUi.getState().bgColor).toEqual([255, 255, 255]);
    useEditUi.getState().close();
  });

  it("alpha_mode_without_alpha_becomes_color", async () => {
    await openOn("removeBg", { removeBg: { ...memory().removeBg, mode: "alpha" } });
    const s = useEditUi.getState();
    expect(s.tab).toBe("removeBg");
    expect(s.removeBg.mode).toBe("color");
    s.close();
    await openOn("removeBg", { removeBg: { ...memory().removeBg, mode: "alpha" } }, { ...opened(4), hasAlpha: true });
    expect(useEditUi.getState().removeBg.mode).toBe("alpha");
    useEditUi.getState().close();
  });

  it("current_params_for_crop_and_remove_bg", async () => {
    editPick.mockResolvedValue([9, 8, 7]);
    await openOn("crop");
    const st = useEditUi.getState();
    expect(currentParams(st)).toEqual({ op: "crop", rect: full, quarterTurns: 0, flipH: false, flipV: false });
    st.setTab("removeBg");
    expect(currentParams(useEditUi.getState())).toEqual({
      op: "removeBg", mode: "color", color: [9, 8, 7], tolerance: 10, softness: 10, edgeConnected: true,
    });
    useEditUi.getState().patch("removeBg", { mode: "alpha", threshold: 20, below: false });
    expect(currentParams(useEditUi.getState())).toEqual({ op: "removeBg", mode: "alpha", threshold: 20, below: false });
    useEditUi.getState().close();
  });

  it("crop_tab_skips_proxy_requests_and_removeBg_resumes", async () => {
    await openOn("crop");
    editPreview.mockClear();
    useEditUi.getState().setCropState({ rect: { x: 1, y: 1, w: 10, h: 10 }, quarterTurns: 1, flipH: true, flipV: false });
    expect(editPreview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(editPreview).toHaveBeenCalledTimes(1);
    expect(editPreview.mock.calls[0][3]).toBe(true);
    editPreview.mockClear();
    useEditUi.getState().setTab("removeBg");
    expect(editPreview).toHaveBeenCalledTimes(1);
    expect(editPreview.mock.calls[0][3]).toBe(false);
    useEditUi.getState().close();
  });

  it("crop_state_survives_tab_round_trip", async () => {
    await openOn("crop");
    const next = { rect: { x: 5, y: 5, w: 20, h: 20 }, quarterTurns: 2 as const, flipH: false, flipV: true };
    useEditUi.getState().setCropState(next);
    useEditUi.getState().setTab("removeBg");
    useEditUi.getState().setTab("crop");
    expect(useEditUi.getState().cropState).toEqual(next);
    useEditUi.getState().close();
  });

  it("pick_updates_color_and_previews_once", async () => {
    await openOn("removeBg");
    editPick.mockResolvedValue([10, 20, 30]);
    editPreview.mockClear();
    await useEditUi.getState().pick(4, 5);
    expect(editPick).toHaveBeenLastCalledWith(3, 4, 5);
    expect(useEditUi.getState().bgColor).toEqual([10, 20, 30]);
    expect(editPreview).toHaveBeenCalledTimes(1);
    useEditUi.getState().close();
  });

  it("commit_memory_has_crop_and_remove_bg_but_not_transient_state", async () => {
    await openOn("crop");
    useEditUi.getState().patch("crop", { ratio: "16:9" });
    useEditUi.getState().patch("removeBg", { tolerance: 33 });
    await useEditUi.getState().commitMemory();
    const arg = editParamsSet.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.tab).toBe("crop");
    expect((arg.crop as { ratio: string }).ratio).toBe("16:9");
    expect((arg.removeBg as { tolerance: number }).tolerance).toBe(33);
    expect(arg).not.toHaveProperty("cropState");
    expect(arg).not.toHaveProperty("bgColor");
    useEditUi.getState().close();
  });

  it("crop_is_identity", () => {
    const o = { width: 100, height: 50 };
    const id = { rect: full, quarterTurns: 0 as const, flipH: false, flipV: false };
    expect(cropIsIdentity(id, o)).toBe(true);
    expect(cropIsIdentity({ ...id, rect: { ...full, w: 99 } }, o)).toBe(false);
    expect(cropIsIdentity({ ...id, quarterTurns: 1 }, o)).toBe(false);
    expect(cropIsIdentity({ ...id, flipH: true }, o)).toBe(false);
    expect(cropIsIdentity({ ...id, flipV: true }, o)).toBe(false);
  });
});
