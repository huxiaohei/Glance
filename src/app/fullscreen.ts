import { getCurrentWindow } from "@tauri-apps/api/window";

/** 切换当前窗口的全屏状态；不在 Tauri 里（如测试）或调用失败时静默忽略。 */
export async function toggleFullscreen(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch {
    // 无窗口可切换
  }
}
