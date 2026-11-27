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

const { useEditUi, currentParams, cropIsIdentity, compressUnsupported } = await import("./editUi");

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

  it("open_heif_falls_back_to_convert_and_marks_compress_unsupported", async () => {
    editParamsGet.mockResolvedValue(memory("compress"));
    editOpen.mockResolvedValue(opened(1, "heif"));
    await useEditUi.getState().open(7);
    const s = useEditUi.getState();
    expect(s.tab).toBe("convert");
    expect(compressUnsupported({ tab: "compress", opened: s.opened })).toBe(true);
    expect(compressUnsupported(s)).toBe(false);
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

  it("result_in_flight_before_tab_change_is_not_shown", async () => {
    await openOn("compress");
    await vi.advanceTimersByTimeAsync(300);
    const before = useEditUi.getState().result!.rev;
    const pending = new Map<number, (r: PreviewResult) => void>();
    editPreview.mockImplementation((_s, rev) => new Promise((r) => pending.set(rev, r)));
    useEditUi.getState().patch("compress", { quality: 40 }); // 压缩页的代理请求在途
    const old = Math.max(...pending.keys());
    useEditUi.getState().setTab("removeBg");
    const fresh = Math.max(...pending.keys());
    expect(fresh).toBeGreaterThan(old);
    pending.get(old)!(prev(old));
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditUi.getState().result!.rev).toBe(before);
    expect(useEditUi.getState().resultUrl).toBe(`u/3/${before}`);
    pending.get(fresh)!(prev(fresh));
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditUi.getState().result!.rev).toBe(fresh);
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

  it("crop_identity_sends_no_preview_until_changed", async () => {
    editPreview.mockClear();
    await openOn("crop");
    await vi.advanceTimersByTimeAsync(500);
    expect(editPreview).not.toHaveBeenCalled();
    expect(useEditUi.getState().result).toBeNull();
    const changed = { rect: { x: 1, y: 1, w: 10, h: 10 }, quarterTurns: 0 as const, flipH: false, flipV: false };
    useEditUi.getState().setCropState(changed);
    await vi.advanceTimersByTimeAsync(250);
    expect(editPreview).toHaveBeenCalledTimes(1);
    expect(editPreview.mock.calls[0][2]).toMatchObject({ op: "crop", rect: changed.rect });
    expect(useEditUi.getState().result).not.toBeNull();
    // 改回“没改”：待发的全尺寸取消，旧结果丢掉
    editPreview.mockClear();
    useEditUi.getState().setCropState({ ...changed, rect: { x: 2, y: 2, w: 10, h: 10 } });
    useEditUi.getState().setCropState({ rect: full, quarterTurns: 0, flipH: false, flipV: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(editPreview).not.toHaveBeenCalled();
    expect(useEditUi.getState().result).toBeNull();
    expect(useEditUi.getState().resultUrl).toBeNull();
    useEditUi.getState().close();
  });

  it("entering_crop_tab_unchanged_sends_no_preview", async () => {
    await openOn("compress");
    editPreview.mockClear();
    useEditUi.getState().setTab("crop");
    await vi.advanceTimersByTimeAsync(500);
    expect(editPreview).not.toHaveBeenCalled();
    useEditUi.getState().setTab("compress");
    expect(editPreview).toHaveBeenCalledTimes(1);
    useEditUi.getState().close();
  });

  it("crop_identity_drops_in_flight_result", async () => {
    await openOn("crop");
    const pending = new Map<number, (r: PreviewResult) => void>();
    editPreview.mockImplementation((_s, rev) => new Promise((r) => pending.set(rev, r)));
    useEditUi.getState().setCropState({ rect: { x: 1, y: 1, w: 10, h: 10 }, quarterTurns: 0, flipH: false, flipV: false });
    await vi.advanceTimersByTimeAsync(250);
    const rev = Math.max(...pending.keys());
    useEditUi.getState().setCropState({ rect: full, quarterTurns: 0, flipH: false, flipV: false });
    pending.get(rev)!(prev(rev));
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditUi.getState().result).toBeNull();
    useEditUi.getState().close();
  });

  it("patch_crop_memory_does_not_preview", async () => {
    await openOn("crop");
    useEditUi.getState().setCropState({ rect: { x: 1, y: 1, w: 10, h: 10 }, quarterTurns: 0, flipH: false, flipV: false });
    await vi.advanceTimersByTimeAsync(300);
    editPreview.mockClear();
    useEditUi.getState().patch("crop", { ratio: "16:9" });
    await vi.advanceTimersByTimeAsync(300);
    expect(editPreview).not.toHaveBeenCalled();
    expect(useEditUi.getState().crop.ratio).toBe("16:9");
    useEditUi.getState().close();
  });

  it("set_tab_clears_preview_error", async () => {
    await openOn("compress");
    useEditUi.setState({ previewError: "unsupported" });
    useEditUi.getState().setTab("crop");
    expect(useEditUi.getState().previewError).toBeNull();
    useEditUi.getState().close();
  });

  it("forced_color_mode_keeps_remembered_alpha_in_memory", async () => {
    await openOn("compress", { removeBg: { ...memory().removeBg, mode: "alpha", tolerance: 22 } });
    expect(useEditUi.getState().removeBg.mode).toBe("color");
    useEditUi.getState().patch("removeBg", { tolerance: 40 });
    await useEditUi.getState().commitMemory();
    const arg = editParamsSet.mock.calls[0][0];
    expect(arg.removeBg.mode).toBe("alpha");
    expect(arg.removeBg.tolerance).toBe(40);
    useEditUi.getState().close();
  });

  it("mode_chosen_in_session_is_remembered", async () => {
    await openOn("removeBg", { removeBg: { ...memory().removeBg, mode: "alpha" } });
    useEditUi.getState().patch("removeBg", { mode: "color" });
    await useEditUi.getState().commitMemory();
    expect(editParamsSet.mock.calls[0][0].removeBg.mode).toBe("color");
    useEditUi.getState().close();
    // 下一次打开（不透明）不再沿用上一张的强制
    editParamsSet.mockClear();
    await openOn("compress", { removeBg: { ...memory().removeBg, mode: "color" } });
    await useEditUi.getState().commitMemory();
    expect(editParamsSet.mock.calls[0][0].removeBg.mode).toBe("color");
    useEditUi.getState().close();
  });

  it("fixed_tab_outside_batch_applies_open_adjustments", async () => {
    // 网格选中一张按“压缩”进入：GIF 不能压缩，同普通打开一样落到转格式页
    editParamsGet.mockResolvedValue({ ...memory("crop"), removeBg: { ...memory().removeBg, mode: "alpha" } });
    editOpen.mockResolvedValue(opened(1, "gif"));
    await useEditUi.getState().open(7, { tab: "compress" });
    expect(useEditUi.getState().tab).toBe("convert");
    useEditUi.getState().close();
    // 按“去背景”进入一张不透明的图：记忆里的“按透明度”改成“按颜色”，记忆仍写回原方式
    editOpen.mockResolvedValue(opened(2));
    await useEditUi.getState().open(8, { tab: "removeBg" });
    const s = useEditUi.getState();
    expect(s.tab).toBe("removeBg");
    expect(s.removeBg.mode).toBe("color");
    await s.commitMemory();
    expect(editParamsSet.mock.calls[0][0].removeBg.mode).toBe("alpha");
    useEditUi.getState().close();
  });

  it("fixed_tab_in_batch_keeps_tab_for_gif", async () => {
    // 批量模式的页签是整批的操作，不因这一张是 GIF 而换
    useEditUi.setState({ batch: { ids: [7, 8], plan: null } });
    editParamsGet.mockResolvedValue(memory("crop"));
    editOpen.mockResolvedValue(opened(1, "gif"));
    await useEditUi.getState().open(7, { tab: "compress" });
    expect(useEditUi.getState().tab).toBe("compress");
    useEditUi.getState().close();
    useEditUi.setState({ batch: null });
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
