import { t } from "../i18n";
import { updateCheck, updateInstall } from "../ipc/api";
import { showToast, withBusy } from "../stores/toast";

/** 启动后等这么久再检查更新，不和打开目录抢资源。 */
export const UPDATE_DELAY_MS = 3000;

function offerInstall(version: string): void {
  showToast({
    text: t("update.available", { v: version }),
    sticky: true,
    actions: [{ label: t("update.install"), run: () => void install(version) }],
  });
}

async function install(version: string): Promise<void> {
  try {
    // 成功后应用会重启；失败时后端保留待更新的版本，可再点一次重试
    await withBusy(t("update.installing"), updateInstall());
  } catch {
    showToast({
      text: t("error.updateFailed"),
      sticky: true,
      actions: [{ label: t("update.install"), run: () => void install(version) }],
    });
  }
}

/** 启动 3 秒后检查一次更新；有新版本就出一条带“更新并重启”的提示条，检查失败静默。返回的函数取消尚未触发的检查。 */
export function startUpdateCheck(): () => void {
  const timer = setTimeout(() => {
    updateCheck()
      .then((version) => {
        if (typeof version === "string" && version !== "") offerInstall(version);
      })
      .catch(() => {});
  }, UPDATE_DELAY_MS);
  return () => clearTimeout(timer);
}
