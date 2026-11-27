import { useMemo } from "react";
import { allCommands } from "../../app/commands";
import { pickAndTransfer, trashTargets } from "../../app/fileOps";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { useBatch } from "../../stores/batch";
import { useCatalog } from "../../stores/catalog";
import { allCodecNames } from "../../lib/codecKind";
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

/** 批量按钮：直接执行命令表里的命令；批量进行中禁用；unsupported 时禁用并说明（选中的图都不能压缩）。 */
function BatchButton({ id, label, busy, unsupported = false }: { id: string; label: string; busy: boolean; unsupported?: boolean }) {
  const cmd = allCommands().find((c) => c.id === id);
  if (!cmd) return null;
  return (
    <button
      type="button"
      className="status-action"
      disabled={busy || unsupported}
      title={busy ? t("batch.running") : unsupported ? t("edit.compress.unsupported") : t(cmd.title)}
      onClick={() => cmd.run({ shift: false, repeat: false })}
    >
      {label}
    </button>
  );
}

/** 选中的图全是 HEIC / HEIF / AVIF：这些图不能压缩，“压缩”按钮置灰（混选时由后端跳过）。 */
function useAllCodecSelected(): boolean {
  const ids = useSelection((s) => s.ids);
  const entries = useCatalog((s) => s.entries);
  return useMemo(() => allCodecNames([...ids].map((id) => entries.get(id)?.name ?? "")), [ids, entries]);
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
  const busy = useBatch((s) => s.progress !== null);
  const noneCompressible = useAllCodecSelected();
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
      {selected > 0 && <BatchButton id="grid.batchCompress" label={t("status.compress")} busy={busy} unsupported={noneCompressible} />}
      {selected > 0 && <BatchButton id="grid.batchConvert" label={t("status.convert")} busy={busy} />}
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
