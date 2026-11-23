// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./ipc/api", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  // 最近目录的几个命令返回列表，给空列表
  const lists = new Set(["recentsList", "recentsPin", "recentsRemove"]);
  return Object.fromEntries(
    Object.keys(real).map((k) => [k, vi.fn(() => Promise.resolve(lists.has(k) ? [] : undefined))]),
  );
});

const { default: App } = await import("./App");
const { DEFAULT_SETTINGS, updateSettings, useSettings } = await import("./stores/settings");
const { startApplyingSettings } = await import("./app/applySettings");
const { setLanguage } = await import("./i18n");
const { useCatalog } = await import("./stores/catalog");
const { useNav, topView } = await import("./stores/nav");
const { useSelection } = await import("./stores/selection");
const { selectOnly } = await import("./lib/selection");

let stop = () => {};
afterEach(() => {
  cleanup();
  stop();
  stop = () => {};
  setLanguage("zh-CN");
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: false });
  act(() => useCatalog.getState().reset());
  useNav.getState().reset();
  useSelection.getState().clear();
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

  it("切换语言（视图树重新挂载）不会再次进入打开时的单张视图，也不改选中", () => {
    // jsdom 不做布局：给滚动区一个尺寸，网格才会排布并处理 focus
    const descs = (["clientWidth", "clientHeight"] as const).map((p) => [p, Object.getOwnPropertyDescriptor(Element.prototype, p)!] as const);
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 400 });
    try {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, language: "zh-CN" } });
      stop = startApplyingSettings();
      act(() => {
        useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: 3 });
        useCatalog.getState().apply({
          type: "batch",
          generation: 1,
          entries: [1, 2, 3].map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
        });
      });
      render(<App />);
      expect(topView().kind).toBe("single");
      act(() => useNav.getState().back());
      act(() => useSelection.getState().set(selectOnly(1)));
      act(() => updateSettings({ language: "en" }));
      expect(topView().kind).toBe("grid");
      expect([...useSelection.getState().ids]).toEqual([1]);
    } finally {
      for (const [p, d] of descs) Object.defineProperty(Element.prototype, p, d);
    }
  });
});
