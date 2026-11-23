import { allCommands } from "../../app/commands";
import { trashTargets } from "../../app/fileOps";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import { useSelection } from "../../stores/selection";

/** 删除按钮的悬停提示：命令名加它的第一个快捷键（取自命令表）。 */
function deleteTitle(): string {
  const cmd = allCommands().find((c) => c.id === "file.trash");
  if (!cmd || cmd.keys.length === 0) return t("status.delete");
  return `${t(cmd.title)} (${formatKey(cmd.keys[0], IS_MAC)})`;
}

export default function StatusBar({ total }: { total: number }) {
  const watchFailed = useCatalog((s) => s.watchFailed);
  const selected = useSelection((s) => s.ids.size);
  return (
    <div className="status-bar">
      <span className="status-counts">
        <span>{t("grid.total", { n: total })}</span>
        {selected > 0 && <span>{t("status.selected", { n: selected })}</span>}
      </span>
      {watchFailed && <span className="status-warn">{t("status.watchFailed")}</span>}
      {selected > 0 && (
        <button type="button" className="status-action" title={deleteTitle()} onClick={() => void trashTargets()}>
          {t("status.delete")}
        </button>
      )}
    </div>
  );
}
