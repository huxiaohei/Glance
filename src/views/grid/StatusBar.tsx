import { useMemo } from "react";
import { allCommands } from "../../app/commands";
import { pickAndTransfer, trashTargets } from "../../app/fileOps";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { gridHints } from "../../lib/keyHints";
import { useSelection } from "../../stores/selection";
import { useSettings } from "../../stores/settings";
import KeyHints from "../common/KeyHints";

/** 删除按钮的悬停提示：命令名加它的第一个快捷键（取自命令表）。 */
function deleteTitle(): string {
  const cmd = allCommands().find((c) => c.id === "file.trash");
  if (!cmd || cmd.keys.length === 0) return t("status.delete");
  return `${t(cmd.title)} (${formatKey(cmd.keys[0], IS_MAC)})`;
}

/** 移动按钮的悬停提示：取自命令表里 file.moveTo 的标题（没有快捷键）。 */
function moveTitle(): string {
  const cmd = allCommands().find((c) => c.id === "file.moveTo");
  return cmd ? t(cmd.title) : t("status.move");
}

/** 选中的图里有几张还不在对比篮里。 */
function useSelectedNotInBasket(): number {
  const ids = useSelection((s) => s.ids);
  const order = useBasket((s) => s.order);
  return useMemo(() => {
    if (ids.size === 0) return 0;
    const inBasket = new Set(order);
    let n = 0;
    for (const id of ids) if (!inBasket.has(id)) n++;
    return n;
  }, [ids, order]);
}

export default function StatusBar({ total }: { total: number }) {
  const watchFailed = useCatalog((s) => s.watchFailed);
  const selected = useSelection((s) => s.ids.size);
  const inBasket = useBasket((s) => s.order.length);
  const showHints = useSettings((s) => s.settings.showKeyHints);
  const notInBasket = useSelectedNotInBasket();
  return (
    <div className="status-bar">
      <span className="status-counts">
        <span>{t("grid.total", { n: total })}</span>
        {selected > 0 && <span aria-hidden="true">{t("status.sep")}</span>}
        {selected > 0 && <span>{t("status.selected", { n: selected })}</span>}
        {inBasket > 0 && <span aria-hidden="true">{t("status.sep")}</span>}
        {inBasket > 0 && <span>{t("basket.status", { n: inBasket })}</span>}
      </span>
      {watchFailed && <span className="status-warn">{t("status.watchFailed")}</span>}
      {showHints && <KeyHints hints={gridHints({ selected, selectedNotInBasket: notInBasket, basket: inBasket })} />}
      {selected > 0 && (
        <button type="button" className="status-action" title={moveTitle()} onClick={() => void pickAndTransfer("move")}>
          {t("status.move")}
        </button>
      )}
      {selected > 0 && (
        <button type="button" className="status-action" title={deleteTitle()} onClick={() => void trashTargets()}>
          {t("status.delete")}
        </button>
      )}
    </div>
  );
}
