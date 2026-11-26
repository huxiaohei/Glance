// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/api", () => ({ settingsGet: vi.fn(), settingsSet: vi.fn(() => Promise.resolve()) }));
const updateSettings = vi.fn();
vi.mock("../../stores/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../stores/settings")>();
  return { ...real, updateSettings: (...a: Parameters<typeof real.updateSettings>) => updateSettings(...a) };
});

const { default: SettingsDialog } = await import("./SettingsDialog");
const { DEFAULT_SETTINGS, useSettings } = await import("../../stores/settings");
const { useTip } = await import("../../stores/tip");
const { t } = await import("../../i18n");

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: true });
});
afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: false });
  updateSettings.mockClear();
});

const control = (key: Parameters<typeof t>[0]) => screen.getByLabelText(t(key)) as HTMLSelectElement & HTMLInputElement;

describe("SettingsDialog", () => {
  it("点“打赏”按钮：设置关闭，打赏面板打开", () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: t("tip.entry") }));
    expect(useSettings.getState().open).toBe(false);
    expect(useTip.getState().open).toBe(true);
    useTip.setState({ open: false });
  });

  it("open 为假时不渲染", () => {
    useSettings.setState({ open: false });
    const { container } = render(<SettingsDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("有 role=dialog 与 aria-modal，七个控件都能按标签文字找到", () => {
    render(<SettingsDialog />);
    const dialog = screen.getByRole("dialog", { name: t("settings.title") });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(control("settings.theme").tagName).toBe("SELECT");
    expect(control("settings.language").tagName).toBe("SELECT");
    expect(control("settings.includeSubdirs").type).toBe("checkbox");
    expect(control("settings.defaultSort").tagName).toBe("SELECT");
    expect(control("settings.loopAtEnd").type).toBe("checkbox");
    expect(control("settings.wheel").tagName).toBe("SELECT");
    expect(control("settings.checkUpdates").type).toBe("checkbox");
    // 语言名不翻译
    const langs = [...control("settings.language").options].map((o) => o.textContent);
    expect(langs).toContain("简体中文");
    expect(langs).toContain("English");
    // 排序文字复用 sort.*
    const sorts = [...control("settings.defaultSort").options].map((o) => o.textContent);
    expect(sorts).toEqual([t("sort.name"), t("sort.mtime"), t("sort.size")]);
  });

  it("各控件显示当前设置的值", () => {
    useSettings.setState({
      settings: { theme: "light", language: "en", includeSubdirs: false, defaultSort: "size", loopAtEnd: true, wheel: "switch", checkUpdates: true, compareColumns: 3, compareSyncOnEnter: false, compareBackground: "dark", showKeyHints: false, editSaveMode: "copy", batchOutputDir: "_glance_output" },
    });
    render(<SettingsDialog />);
    expect(control("settings.theme").value).toBe("light");
    expect(control("settings.language").value).toBe("en");
    expect(control("settings.includeSubdirs").checked).toBe(false);
    expect(control("settings.defaultSort").value).toBe("size");
    expect(control("settings.loopAtEnd").checked).toBe(true);
    expect(control("settings.wheel").value).toBe("switch");
    expect(control("settings.compareColumns").value).toBe("3");
    expect(control("settings.compareSyncOnEnter").checked).toBe(false);
    expect(control("settings.showKeyHints").checked).toBe(false);
  });

  it("改主题下拉框调用 updateSettings({ theme: 'light' })", () => {
    render(<SettingsDialog />);
    fireEvent.change(control("settings.theme"), { target: { value: "light" } });
    expect(updateSettings).toHaveBeenCalledWith({ theme: "light" });
  });

  it("其余控件各自调用 updateSettings", () => {
    render(<SettingsDialog />);
    fireEvent.change(control("settings.language"), { target: { value: "en" } });
    fireEvent.click(control("settings.includeSubdirs"));
    fireEvent.change(control("settings.defaultSort"), { target: { value: "mtime" } });
    fireEvent.change(control("settings.wheel"), { target: { value: "switch" } });
    expect(updateSettings.mock.calls).toEqual([
      [{ language: "en" }],
      [{ includeSubdirs: false }],
      [{ defaultSort: "mtime" }],
      [{ wheel: "switch" }],
    ]);
  });

  it("勾选“翻到最后一张时回到第一张”调用 updateSettings({ loopAtEnd: true })", () => {
    render(<SettingsDialog />);
    fireEvent.click(control("settings.loopAtEnd"));
    expect(updateSettings).toHaveBeenCalledWith({ loopAtEnd: true });
  });

  it("点遮罩和“关闭”按钮都把 open 置为假；点对话框内部不关闭", () => {
    const { container } = render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(useSettings.getState().open).toBe(true);
    fireEvent.click(container.querySelector(".settings-backdrop")!);
    expect(useSettings.getState().open).toBe(false);

    act(() => useSettings.setState({ open: true }));
    fireEvent.click(screen.getByRole("button", { name: t("settings.close") }));
    expect(useSettings.getState().open).toBe(false);
  });

  it("打开时焦点在对话框内", () => {
    render(<SettingsDialog />);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("勾掉“启动时检查更新”后保存 checkUpdates: false", () => {
    render(<SettingsDialog />);
    fireEvent.click(control("settings.checkUpdates"));
    expect(updateSettings).toHaveBeenCalledWith({ checkUpdates: false });
  });

  it("改每排张数调用 updateSettings({ compareColumns: 6 })，选项为 2 到 8", () => {
    render(<SettingsDialog />);
    const sel = control("settings.compareColumns");
    expect([...sel.options].map((o) => o.value)).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    fireEvent.change(sel, { target: { value: "6" } });
    expect(updateSettings).toHaveBeenCalledWith({ compareColumns: 6 });
  });

  it("勾掉“进入对比时开启同步缩放”保存 compareSyncOnEnter: false", () => {
    render(<SettingsDialog />);
    fireEvent.click(control("settings.compareSyncOnEnter"));
    expect(updateSettings).toHaveBeenCalledWith({ compareSyncOnEnter: false });
  });

  it("勾掉“显示快捷键提示”保存 showKeyHints: false", () => {
    render(<SettingsDialog />);
    const box = control("settings.showKeyHints");
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(updateSettings).toHaveBeenCalledWith({ showKeyHints: false });
  });

  it("edit_save_mode_option_persists", () => {
    render(<SettingsDialog />);
    const group = screen.getByRole("radiogroup", { name: t("settings.editSaveMode") });
    const copy = screen.getByRole("radio", { name: t("edit.save.copy") }) as HTMLInputElement;
    const over = screen.getByRole("radio", { name: t("edit.save.overwrite") }) as HTMLInputElement;
    expect(group.contains(copy)).toBe(true);
    expect(copy.checked).toBe(true);
    expect(over.checked).toBe(false);
    fireEvent.click(over);
    expect(updateSettings).toHaveBeenCalledWith({ editSaveMode: "overwrite" });
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, editSaveMode: "overwrite" } }));
    expect(over.checked).toBe(true);
  });

  it("batch_output_dir_validates_on_blur_and_saves_on_enter", () => {
    render(<SettingsDialog />);
    const input = control("settings.batchOutputDir") as HTMLInputElement;
    expect(input.value).toBe("_glance_output");
    fireEvent.change(input, { target: { value: "a/b" } });
    fireEvent.blur(input);
    expect(screen.getByText(t("settings.batchOutputDir.invalid"))).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " out " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ batchOutputDir: "out" });
    expect(screen.queryByText(t("settings.batchOutputDir.invalid"))).toBeNull();
  });
});
