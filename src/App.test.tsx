// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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
const { DEFAULT_SETTINGS, useSettings } = await import("./stores/settings");
const { setLanguage } = await import("./i18n");

afterEach(() => {
  cleanup();
  setLanguage("zh-CN");
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

describe("App", () => {
  it("语言从 zh-CN 改成 en 后，启动页的按钮文字变成英文", () => {
    setLanguage("zh-CN");
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, language: "zh-CN" } });
    render(<App />);
    expect(screen.getByRole("button", { name: "打开目录" })).toBeTruthy();
    act(() => {
      setLanguage("en");
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, language: "en" } });
    });
    expect(screen.getByRole("button", { name: "Open Folder" })).toBeTruthy();
  });
});
