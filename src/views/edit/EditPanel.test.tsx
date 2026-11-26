// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleKeyDown } from "../../app/useKeyboard";
import { t } from "../../i18n";
import { editClose, editOpen, editParamsGet, editParamsSet, editPreview, editSave } from "../../ipc/api";
import type { EditOpened, PreviewResult } from "../../ipc/types";
import { useCatalog } from "../../stores/catalog";
import { useEditUi } from "../../stores/editUi";
import { useNav } from "../../stores/nav";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import EditPanel from "./EditPanel";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const opened = (o: Partial<EditOpened> = {}): EditOpened => ({
  session: 1, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000, ...o,
});
const result = (o: Partial<PreviewResult> = {}): PreviewResult => ({
  rev: 1, bytes: 500, approx: false, format: "jpeg", width: 100, height: 50, ...o,
});

const settle = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
});

async function editing(o: Partial<EditOpened> = {}) {
  vi.mocked(editOpen).mockResolvedValue(opened(o));
  await act(() => useEditUi.getState().open(2));
  const r = render(<EditPanel />);
  await settle();
  return r;
}

const lastParams = () => vi.mocked(editPreview).mock.calls[vi.mocked(editPreview).mock.calls.length - 1][2];

beforeEach(() => {
  vi.mocked(editParamsGet).mockRejectedValue("none");
  vi.mocked(editParamsSet).mockResolvedValue();
  vi.mocked(editClose).mockResolvedValue();
  vi.mocked(editPreview).mockImplementation(async (_s, rev) => result({ rev }));
  vi.mocked(editSave).mockResolvedValue({ id: 10, name: "2_compressed.jpg", bytes: 500, token: 7, outside: false });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useCatalog.getState().reset();
  useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
  useCatalog.getState().apply({ type: "batch", generation: 1, entries: [{ id: 2, size: 1000, mtimeMs: 1, relPath: "2.jpg" }] });
  useNav.getState().reset();
  useNav.getState().openSingle(2);
});
afterEach(() => {
  act(() => useEditUi.getState().close());
  vi.clearAllMocks();
});

describe("编辑面板", () => {
  it("opening_shows_loading", async () => {
    let resolve: (o: EditOpened) => void = () => {};
    vi.mocked(editOpen).mockReturnValue(new Promise<EditOpened>((r) => (resolve = r)));
    let pending!: Promise<void>;
    act(() => {
      pending = useEditUi.getState().open(2);
    });
    render(<EditPanel />);
    await settle();
    expect(useEditUi.getState().status).toBe("opening");
    expect(screen.getByRole("status").textContent).toBe(t("edit.loading"));
    await act(async () => {
      resolve(opened());
      await pending;
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("slider_change_triggers_preview", async () => {
    await editing();
    vi.mocked(editPreview).mockClear();
    fireEvent.change(screen.getByLabelText(t("edit.quality")), { target: { value: "50" } });
    await settle();
    expect(editPreview).toHaveBeenCalled();
    expect(lastParams()).toEqual(expect.objectContaining({ op: "compress", quality: 50 }));
  });

  it("max_edge_toggle_and_input", async () => {
    await editing();
    const edge = screen.getByLabelText(t("edit.maxEdge.value")) as HTMLInputElement;
    expect(edge.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(t("edit.maxEdge")));
    expect(edge.disabled).toBe(false);
    await settle();
    expect(lastParams()).toEqual(expect.objectContaining({ maxEdge: 2048 }));
    fireEvent.change(edge, { target: { value: "1200" } });
    await settle();
    expect(lastParams()).toEqual(expect.objectContaining({ maxEdge: 1200 }));
    // 超出范围的不采用，失焦后显示回有效值
    fireEvent.change(edge, { target: { value: "70000" } });
    fireEvent.blur(edge);
    expect(useEditUi.getState().compress.maxEdge).toBe(1200);
    expect(edge.value).toBe("1200");
  });

  it("png_lossless_disables_quality", async () => {
    await editing({ srcFormat: "png" });
    const quality = screen.getByLabelText(t("edit.quality")) as HTMLInputElement;
    expect(quality.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(t("edit.pngMode.lossless")));
    expect(quality.disabled).toBe(true);
    await settle();
    expect(lastParams()).toEqual(expect.objectContaining({ pngMode: "lossless" }));
  });

  it("png_mode_only_for_png_source", async () => {
    await editing();
    expect(screen.queryByLabelText(t("edit.pngMode.lossless"))).toBeNull();
  });

  it("fill_color_only_for_alpha_to_jpeg", async () => {
    await editing({ srcFormat: "png", hasAlpha: true });
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.convert") }));
    // 默认 JPG：出现填充色
    expect(screen.getByLabelText(t("edit.fill.white"))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(t("edit.fill.black")));
    expect(useEditUi.getState().convert.fill).toEqual([0, 0, 0]);
    fireEvent.change(screen.getByLabelText(t("edit.fill.custom")), { target: { value: "#336699" } });
    expect(useEditUi.getState().convert.fill).toEqual([0x33, 0x66, 0x99]);
    fireEvent.click(screen.getByLabelText("WebP"));
    expect(screen.queryByLabelText(t("edit.fill.white"))).toBeNull();
  });

  it("no_fill_without_alpha", async () => {
    await editing({ srcFormat: "png", hasAlpha: false });
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.convert") }));
    expect(screen.queryByLabelText(t("edit.fill.white"))).toBeNull();
  });

  it("png_target_disables_quality", async () => {
    await editing();
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.convert") }));
    const quality = screen.getByLabelText(t("edit.quality")) as HTMLInputElement;
    expect(quality.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("PNG"));
    expect(quality.disabled).toBe(true);
  });

  it("all_four_tabs_clickable", async () => {
    await editing();
    for (const [label, key] of [
      ["edit.tab.crop", "crop"], ["edit.tab.removeBg", "removeBg"], ["edit.tab.convert", "convert"], ["edit.tab.compress", "compress"],
    ] as const) {
      const tab = screen.getByRole("tab", { name: t(label) }) as HTMLButtonElement;
      expect(tab.disabled).toBe(false);
      fireEvent.click(tab);
      expect(useEditUi.getState().tab).toBe(key);
      expect(tab.getAttribute("aria-selected")).toBe("true");
    }
  });

  it("crop_tab_hides_hold_original", async () => {
    await editing();
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.crop") }));
    expect(screen.queryByRole("button", { name: t("edit.holdOriginal") })).toBeNull();
    expect(screen.getByRole("button", { name: t("edit.crop.rotateLeft") })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.removeBg") }));
    expect(screen.getByRole("button", { name: t("edit.holdOriginal") })).toBeTruthy();
  });

  it("crop_unchanged_disables_save_until_changed", async () => {
    await editing();
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.crop") }));
    const primary = screen.getByRole("button", { name: t("edit.save.copy") }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(screen.getByText(t("edit.crop.unchanged"))).toBeTruthy();
    act(() => useEditUi.getState().setCropState({ ...useEditUi.getState().cropState!, flipH: true }));
    expect(primary.disabled).toBe(false);
    expect(screen.queryByText(t("edit.crop.unchanged"))).toBeNull();
    // 别的页签不受此规则影响
    act(() => useEditUi.getState().setCropState({ ...useEditUi.getState().cropState!, flipH: false }));
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.removeBg") }));
    expect(primary.disabled).toBe(false);
  });

  it("crop_footer_shows_dimensions", async () => {
    const { container } = await editing();
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.crop") }));
    act(() => useEditUi.setState({ result: null }));
    const footer = () => container.querySelector(".edit-size")!.textContent!;
    expect(footer()).toContain("100×50");
    expect(footer()).toContain(t("edit.size.computing"));
    act(() => useEditUi.setState({ result: result({ width: 40, height: 30, bytes: 300 }) }));
    expect(footer()).toContain("40×30");
    expect(footer()).toContain("300 B");
  });

  it("gif_compress_unsupported_disables_save", async () => {
    await editing({ srcFormat: "gif" });
    // 打开时落到转格式
    expect(useEditUi.getState().tab).toBe("convert");
    const primary = screen.getByRole("button", { name: t("edit.save.copy") }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.compress") }));
    expect(screen.getByText(t("edit.compress.unsupported"))).toBeTruthy();
    expect(primary.disabled).toBe(true);
  });

  it("footer_shows_approx_then_exact", async () => {
    const { container } = await editing();
    act(() => useEditUi.setState({ result: result({ bytes: 512, approx: true }) }));
    const footer = () => container.querySelector(".edit-size")!.textContent!;
    expect(footer()).toContain("JPG · 1000 B");
    expect(footer()).toContain(t("edit.size.approx", { size: "512 B" }));
    expect(footer()).toContain(t("edit.size.saved", { pct: 49 }));
    act(() => useEditUi.setState({ result: result({ bytes: 500, approx: false }) }));
    expect(footer()).not.toContain(t("edit.size.approx", { size: "500 B" }));
    expect(footer()).toContain("500 B");
    expect(footer()).toContain(t("edit.size.saved", { pct: 50 }));
  });

  it("remove_bg_footer_shows_computing_while_approx", async () => {
    const { container } = await editing({ srcFormat: "png", hasAlpha: true });
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.removeBg") }));
    // 页签内容换成去背景
    expect(screen.getByRole("radio", { name: t("edit.removeBg.mode.color") })).toBeTruthy();
    const out = () => container.querySelector(".edit-size-out")!.textContent!;
    act(() => useEditUi.setState({ result: result({ bytes: 512, approx: true, format: "png" }) }));
    expect(out()).toBe(t("edit.size.computing"));
    expect(container.querySelector(".edit-size")!.textContent).not.toContain("512 B");
    act(() => useEditUi.setState({ result: result({ bytes: 800, approx: false, format: "png" }) }));
    expect(out()).toBe("PNG · 800 B");
  });

  it("footer_marks_larger", async () => {
    const { container } = await editing();
    act(() => useEditUi.setState({ result: result({ bytes: 1500, format: "png" }) }));
    const footer = container.querySelector(".edit-size")!;
    expect(footer.classList.contains("is-larger")).toBe(true);
    expect(footer.textContent).toContain(t("edit.size.larger", { pct: 50 }));
    expect(footer.textContent).toContain("PNG · 1.5 KB");
  });

  it("confirm_only_when_temporarily_overwriting", async () => {
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.more") }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("edit.save.overwrite") }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(t("edit.confirm.body"));
    expect(editSave).not.toHaveBeenCalled();
    // 取消：什么也不做
    fireEvent.click(within(dialog).getByRole("button", { name: t("edit.confirm.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editSave).not.toHaveBeenCalled();
    // 再来一次并确认
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.more") }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("edit.save.overwrite") }));
    fireEvent.click(screen.getByRole("button", { name: t("edit.confirm.ok") }));
    await settle();
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "overwrite" });
  });

  it("primary_copy_saves_without_confirm", async () => {
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.copy") }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "copy" });
  });

  it("default_overwrite_saves_without_confirm", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, editSaveMode: "overwrite" } });
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.overwrite") }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "overwrite" });
  });

  it("overwrite_default_menu_offers_copy", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, editSaveMode: "overwrite" } });
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.more") }));
    expect(screen.queryByRole("menuitem", { name: t("edit.save.overwrite") })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: t("edit.save.copy") }));
    await settle();
    expect(vi.mocked(editSave).mock.calls[0][2]).toEqual({ kind: "copy" });
  });

  it("confirm_esc_closes_dialog_only", async () => {
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.more") }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("edit.save.overwrite") }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => handleKeyDown(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useEditUi.getState().status).toBe("ready");
    expect(editSave).not.toHaveBeenCalled();
  });

  it("save_failure_stays_in_edit_with_reason", async () => {
    vi.mocked(editSave).mockRejectedValue("readOnly");
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.save.copy") }));
    await settle();
    expect(useEditUi.getState().status).toBe("ready");
    expect(screen.getByRole("alert").textContent).toBe(t("fs.err.readOnly"));
  });

  it("saving_disables_buttons", async () => {
    vi.mocked(editSave).mockImplementation(() => new Promise(() => {}));
    await editing();
    const primary = screen.getByRole("button", { name: t("edit.save.copy") }) as HTMLButtonElement;
    fireEvent.click(primary);
    await settle();
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toBe(t("edit.save.saving"));
    act(() => useEditUi.setState({ status: "ready" }));
  });

  it("preview_error_is_shown", async () => {
    vi.mocked(editPreview).mockRejectedValue("encode");
    await editing();
    expect(screen.getByRole("alert").textContent).toBe(t("edit.err.preview"));
    vi.mocked(editPreview).mockImplementation(async (_s, rev) => result({ rev }));
    fireEvent.change(screen.getByLabelText(t("edit.quality")), { target: { value: "60" } });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancel_closes_edit", async () => {
    await editing();
    fireEvent.click(screen.getByRole("button", { name: t("edit.cancel") }));
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("crop_tab_switch_drops_stale_result_from_footer", async () => {
    const { container } = await editing();
    const footer = () => container.querySelector(".edit-size")!.textContent!;
    act(() => useEditUi.setState({ result: result({ bytes: 512, width: 100, height: 50 }) }));
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.crop") }));
    expect(useEditUi.getState().result).toBeNull();
    expect(useEditUi.getState().resultUrl).toBeNull();
    expect(footer()).toContain(t("edit.size.computing"));
    expect(footer()).not.toContain("512 B");
    act(() => useEditUi.setState({ result: result({ bytes: 300, width: 40, height: 30 }), resultUrl: "glance://x/1" }));
    fireEvent.click(screen.getByRole("tab", { name: t("edit.tab.compress") }));
    expect(footer()).toContain(t("edit.size.computing"));
    expect(footer()).not.toContain("300 B");
    expect(useEditUi.getState().resultUrl).toBeNull();
  });

  it("switching_tab_releases_hold_original", async () => {
    await editing();
    fireEvent.pointerDown(screen.getByRole("button", { name: t("edit.holdOriginal") }));
    expect(useEditUi.getState().showOriginal).toBe(true);
    act(() => useEditUi.getState().setTab("crop"));
    expect(useEditUi.getState().showOriginal).toBe(false);
  });

  it("hold_original_button", async () => {
    await editing();
    const btn = screen.getByRole("button", { name: t("edit.holdOriginal") });
    fireEvent.pointerDown(btn);
    expect(useEditUi.getState().showOriginal).toBe(true);
    fireEvent.pointerUp(btn);
    expect(useEditUi.getState().showOriginal).toBe(false);
  });
});
