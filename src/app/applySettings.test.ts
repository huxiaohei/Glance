// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/api", () => ({ settingsGet: vi.fn(), settingsSet: vi.fn(() => Promise.resolve()) }));

const { startApplyingSettings } = await import("./applySettings");
const { DEFAULT_SETTINGS, useSettings } = await import("../stores/settings");
const { locale, setLanguage } = await import("../i18n");
const { useListView } = await import("../stores/listView");

let stop: (() => void) | null = null;

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: false });
  useListView.getState().setSort("name");
  delete document.documentElement.dataset.theme;
  document.documentElement.lang = "";
  setLanguage("zh-CN");
});
afterEach(() => {
  stop?.();
  stop = null;
});

const patch = (p: Partial<typeof DEFAULT_SETTINGS>) =>
  useSettings.setState((s) => ({ settings: { ...s.settings, ...p } }));

describe("startApplyingSettings", () => {
  it("启动时把 data-theme 设为当前主题", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, theme: "light", defaultSort: "mtime" } });
    stop = startApplyingSettings();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(useListView.getState().sort).toBe("mtime");
  });

  it("主题改变后 data-theme 跟着变", () => {
    stop = startApplyingSettings();
    expect(document.documentElement.dataset.theme).toBe("dark");
    patch({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    patch({ theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("默认排序改变时改写列表的排序", () => {
    stop = startApplyingSettings();
    useListView.getState().setSort("mtime"); // 用户在工具栏临时改了排序
    patch({ theme: "light" }); // 与排序无关的设置变化不覆盖它
    expect(useListView.getState().sort).toBe("mtime");
    patch({ defaultSort: "size" });
    expect(useListView.getState().sort).toBe("size");
  });

  it("语言改变后调用 setLanguage 并更新 <html lang>", () => {
    stop = startApplyingSettings();
    expect(document.documentElement.lang).toBe(locale());
    patch({ language: "en" });
    expect(locale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    patch({ language: "zh-CN" });
    expect(locale()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("返回的函数取消订阅", () => {
    stop = startApplyingSettings();
    stop();
    stop = null;
    patch({ theme: "light", defaultSort: "size" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(useListView.getState().sort).toBe("name");
  });
});
