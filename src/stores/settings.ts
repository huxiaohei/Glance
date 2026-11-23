import { create } from "zustand";
import { t } from "../i18n";
import { settingsGet, settingsSet } from "../ipc/api";
import type { Settings } from "../ipc/types";
import { showToast } from "./toast";

/** 与后端 `state::settings::Settings::default()` 一致。 */
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  language: "system",
  includeSubdirs: true,
  defaultSort: "name",
  loopAtEnd: false,
  wheel: "zoom",
};

export const useSettings = create<{ settings: Settings; open: boolean }>(() => ({
  settings: DEFAULT_SETTINGS,
  /** 设置对话框是否打开 */
  open: false,
}));

/** 启动时从后端读取设置；失败则保持默认值，不抛。 */
export async function initSettings(): Promise<void> {
  try {
    const settings = await settingsGet();
    useSettings.setState({ settings });
  } catch {
    // 后端读不出时已退回默认值；前端这里同样用默认值继续
  }
}

/** 先改 store（立即生效），再把整份设置交给后端保存；保存失败只提示，不回退。 */
export function updateSettings(patch: Partial<Settings>): void {
  const settings = { ...useSettings.getState().settings, ...patch };
  useSettings.setState({ settings });
  settingsSet(settings).catch(() => showToast({ text: t("settings.saveFailed") }));
}
