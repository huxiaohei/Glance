import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../ipc/types";

const settingsGet = vi.fn<() => Promise<Settings>>();
const settingsSet = vi.fn<(s: Settings) => Promise<void>>();
vi.mock("../ipc/api", () => ({
  settingsGet: () => settingsGet(),
  settingsSet: (s: Settings) => settingsSet(s),
}));

const { DEFAULT_SETTINGS, initSettings, updateSettings, useSettings } = await import("./settings");
const { useToast } = await import("./toast");
const { t } = await import("../i18n");

beforeEach(() => {
  settingsGet.mockReset();
  settingsSet.mockReset();
  useSettings.setState({ settings: DEFAULT_SETTINGS, open: false });
  useToast.setState({ current: null });
});

describe("settings store", () => {
  it("initSettings 把后端的值写进 store", async () => {
    const saved: Settings = { ...DEFAULT_SETTINGS, theme: "light", defaultSort: "size", wheel: "switch" };
    settingsGet.mockResolvedValueOnce(saved);
    await initSettings();
    expect(useSettings.getState().settings).toEqual(saved);
  });

  it("initSettings 在后端拒绝时保持默认值且不抛", async () => {
    settingsGet.mockRejectedValueOnce(new Error("boom"));
    await expect(initSettings()).resolves.toBeUndefined();
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("updateSettings 立刻改 store，并把整份设置发给后端", () => {
    settingsSet.mockResolvedValueOnce();
    updateSettings({ theme: "light" });
    expect(useSettings.getState().settings.theme).toBe("light");
    expect(settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, theme: "light" });
  });

  it("保存失败时显示 settings.saveFailed 提示，store 里的值不回退", async () => {
    settingsSet.mockRejectedValueOnce("io");
    updateSettings({ loopAtEnd: true });
    await vi.waitFor(() => expect(useToast.getState().current?.text).toBe(t("settings.saveFailed")));
    expect(useSettings.getState().settings.loopAtEnd).toBe(true);
  });

  it("DEFAULT_SETTINGS 等于规定的默认值", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: "dark",
      language: "system",
      includeSubdirs: true,
      defaultSort: "name",
      loopAtEnd: false,
      wheel: "zoom",
    });
  });
});
