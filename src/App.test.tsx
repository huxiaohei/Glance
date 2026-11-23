// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./ipc/api", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(real).map((k) => [k, vi.fn(() => Promise.resolve())]));
});

const { default: App } = await import("./App");
const { DEFAULT_SETTINGS, updateSettings, useSettings } = await import("./stores/settings");
const { startApplyingSettings } = await import("./app/applySettings");
const { setLanguage } = await import("./i18n");

let stop = () => {};
afterEach(() => {
  cleanup();
  stop();
  stop = () => {};
  setLanguage("zh-CN");
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: false });
});

describe("App", () => {
  it("语言从 zh-CN 改成 en 后，启动页的按钮文字变成英文", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, language: "zh-CN" } });
    stop = startApplyingSettings();
    render(<App />);
    expect(screen.getByRole("button", { name: "打开目录" })).toBeTruthy();
    act(() => updateSettings({ language: "en" }));
    expect(screen.getByRole("button", { name: "Open Folder" })).toBeTruthy();
  });

  it("在设置对话框里切换语言后，对话框仍然打开，焦点在对话框内", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, language: "zh-CN" }, open: true });
    stop = startApplyingSettings();
    render(<App />);
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en" } });
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("en");
  });
});
