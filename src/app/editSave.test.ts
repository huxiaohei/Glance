import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { editClose, editOpen, editParamsGet, editParamsSet, editPreview, editSave, fsUndo } from "../ipc/api";
import type { EditOpened, SaveReport } from "../ipc/types";
import { useCatalog } from "../stores/catalog";
import { useEditUi } from "../stores/editUi";
import { topView, useNav } from "../stores/nav";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settings";
import { useToast } from "../stores/toast";
import { saveEdit, saveTarget } from "./editSave";

vi.mock("../ipc/api");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const opened = (o: Partial<EditOpened> = {}): EditOpened => ({
  session: 1, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000, ...o,
});
const report = (o: Partial<SaveReport> = {}): SaveReport => ({
  id: 10, name: "2_compressed.jpg", bytes: 500, token: 7, outside: false, ...o,
});

const add = (...ids: number[]) =>
  useCatalog.getState().apply({
    type: "batch",
    generation: 1,
    entries: ids.map((id) => ({ id, size: 1, mtimeMs: 1, relPath: `${id}.jpg` })),
  });

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function editing(o: Partial<EditOpened> = {}) {
  vi.mocked(editOpen).mockResolvedValue(opened(o));
  await useEditUi.getState().open(2);
}

beforeEach(() => {
  vi.mocked(editParamsGet).mockRejectedValue("none");
  vi.mocked(editParamsSet).mockResolvedValue();
  vi.mocked(editClose).mockResolvedValue();
  vi.mocked(editPreview).mockImplementation(async (_s, rev) => ({
    rev, bytes: 10, approx: false, format: "jpeg", width: 100, height: 50,
  }));
  vi.mocked(editSave).mockResolvedValue(report());
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useCatalog.getState().reset();
  useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
  add(1, 2, 3);
  useNav.getState().reset();
  useNav.getState().openSingle(2);
  useToast.setState({ current: null });
});
afterEach(() => {
  useEditUi.getState().close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("saveEdit", () => {
  it("default_copy_saves_copy_and_shows_undo_toast", async () => {
    await editing();
    await saveEdit();
    expect(editSave).toHaveBeenCalledWith(1, expect.objectContaining({ op: "compress", quality: 80 }), { kind: "copy" });
    expect(useEditUi.getState().status).toBe("idle");
    const toast = useToast.getState().current!;
    expect(toast.text).toBe(t("edit.toast.saved", { name: "2_compressed.jpg" }));
    // 编辑已关闭：提示条上的“撤销”立即可用
    toast.actions!.find((a) => a.label === t("fs.undo"))!.run();
    await flush();
    expect(fsUndo).toHaveBeenCalled();
  });

  it("default_overwrite_setting_saves_overwrite", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, editSaveMode: "overwrite" } });
    await editing();
    await saveEdit();
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "overwrite" });
  });

  it("navigates_after_entry_arrives", async () => {
    await editing();
    await saveEdit();
    // 新文件还没进列表：停在原图
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    add(10);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 10 });
  });

  it("navigates_at_once_when_entry_already_there", async () => {
    await editing();
    add(10);
    await saveEdit();
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 10 });
  });

  it("stays_when_entry_never_arrives", async () => {
    vi.useFakeTimers();
    await editing();
    await saveEdit();
    vi.advanceTimersByTime(3000);
    add(10);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
  });

  it("basket_source_does_not_navigate", async () => {
    useNav.getState().reset();
    useNav.getState().openSingle(2, "basket");
    await editing();
    await saveEdit();
    add(10);
    expect(topView()).toEqual({ kind: "single", source: "basket", id: 2 });
    expect(useToast.getState().current?.text).toBe(t("edit.toast.saved", { name: "2_compressed.jpg" }));
  });

  it("outside_does_not_navigate", async () => {
    vi.mocked(editSave).mockResolvedValue(report({ outside: true }));
    await editing();
    await saveEdit();
    add(10);
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
  });

  it("save_failure_stays_in_edit_with_reason", async () => {
    vi.mocked(editSave).mockRejectedValue("diskFull");
    await editing();
    await saveEdit();
    const s = useEditUi.getState();
    expect(s.status).toBe("ready");
    expect(s.saveError).toBe(t("fs.err.diskFull"));
    expect(useToast.getState().current).toBeNull();
  });

  it("overwrite_exists_says_use_copy", async () => {
    vi.mocked(editSave).mockRejectedValue("exists");
    await editing();
    await saveEdit({ kind: "overwrite" });
    expect(useEditUi.getState().saveError).toBe(t("edit.err.overwriteTaken"));
    vi.mocked(editSave).mockRejectedValue("exists");
    await saveEdit({ kind: "copy" });
    expect(useEditUi.getState().saveError).toBe(t("fs.err.exists"));
  });

  it("params_remembered_only_on_success", async () => {
    vi.mocked(editSave).mockRejectedValue("other");
    await editing();
    useEditUi.getState().patch("compress", { quality: 55 });
    await saveEdit();
    expect(editParamsSet).not.toHaveBeenCalled();
    vi.mocked(editSave).mockResolvedValue(report());
    await saveEdit();
    expect(editParamsSet).toHaveBeenCalledWith(expect.objectContaining({ tab: "compress", compress: expect.objectContaining({ quality: 55 }) }));
  });

  it("ignores_second_save_while_saving", async () => {
    let resolve!: (r: SaveReport) => void;
    vi.mocked(editSave).mockImplementation(() => new Promise((r) => { resolve = r; }));
    await editing();
    const first = saveEdit();
    await flush();
    expect(useEditUi.getState().status).toBe("saving");
    await saveEdit();
    expect(editSave).toHaveBeenCalledTimes(1);
    resolve(report());
    await first;
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("save_as_cancel_does_nothing", async () => {
    vi.mocked(saveDialog).mockResolvedValue(null);
    await editing();
    await saveEdit({ kind: "saveAs", path: "" });
    expect(saveDialog).toHaveBeenCalled();
    expect(editSave).not.toHaveBeenCalled();
    expect(useEditUi.getState().status).toBe("ready");
  });

  it("save_as_uses_dialog_path_with_matching_name_and_filter", async () => {
    vi.mocked(saveDialog).mockResolvedValue("/out/x.webp");
    await editing();
    useEditUi.getState().setTab("convert");
    useEditUi.getState().patch("convert", { format: "webp" });
    await saveEdit({ kind: "saveAs", path: "" });
    const arg = vi.mocked(saveDialog).mock.calls[0][0]!;
    expect(arg.defaultPath).toBe("2.webp");
    expect(arg.filters).toEqual([{ name: "WebP", extensions: ["webp"] }]);
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "saveAs", path: "/out/x.webp" });
  });

  it("png_convert_sends_valid_quality", async () => {
    await editing();
    useEditUi.getState().setTab("convert");
    useEditUi.getState().patch("convert", { format: "png", quality: 0 });
    await saveEdit();
    const params = vi.mocked(editSave).mock.calls[0][1];
    expect(params.op === "convert" && params.quality >= 1 && params.quality <= 100).toBe(true);
  });

  it("unsupported_compress_does_not_save", async () => {
    await editing({ srcFormat: "gif" });
    useEditUi.getState().setTab("compress");
    await saveEdit();
    expect(editSave).not.toHaveBeenCalled();
  });
});

describe("saveTarget", () => {
  const compress = { op: "compress" as const, quality: 80, maxEdge: null, pngMode: "lossy" as const };
  const convert = (format: "png" | "jpeg" | "webp") => ({ op: "convert" as const, format, quality: 85, fill: [255, 255, 255] as [number, number, number] });
  it("names_like_backend", () => {
    expect(saveTarget("hero.png", "png", compress).name).toBe("hero_compressed.png");
    expect(saveTarget("a.JPEG", "jpeg", compress).name).toBe("a_compressed.JPEG");
    expect(saveTarget("hero.png", "png", convert("webp")).name).toBe("hero.webp");
    expect(saveTarget("hero.png", "png", convert("jpeg")).name).toBe("hero.jpg");
    expect(saveTarget("hero.png", "png", convert("png")).name).toBe("hero_converted.png");
    expect(saveTarget("a.jpeg", "jpeg", convert("jpeg")).name).toBe("a_converted.jpeg");
    expect(saveTarget("noext", "jpeg", compress).name).toBe("noext_compressed.jpg");
  });
  it("filter_matches_output_format", () => {
    expect(saveTarget("a.jpeg", "jpeg", compress).filter).toEqual({ name: "JPEG", extensions: ["jpeg", "jpg"] });
    expect(saveTarget("a.png", "png", convert("png")).filter).toEqual({ name: "PNG", extensions: ["png"] });
  });
});
