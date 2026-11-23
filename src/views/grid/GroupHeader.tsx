import type { MouseEvent } from "react";
import { t } from "../../i18n";
import { selectGroup } from "../../lib/selection";
import { useGridCtx } from "../../stores/gridCtx";
import { useListView } from "../../stores/listView";
import { useSelection } from "../../stores/selection";

interface Props { dir: string; total: number; collapsed: boolean }

function onSelectGroup(e: MouseEvent<HTMLButtonElement>, dir: string): void {
  e.stopPropagation(); // 不触发标题的折叠
  const sel = useSelection.getState();
  sel.set(selectGroup(sel, useGridCtx.getState().list, dir));
}

export default function GroupHeader({ dir, total, collapsed }: Props) {
  return (
    <div
      className={collapsed ? "group-header group-header-collapsed" : "group-header"}
      onClick={() => useListView.getState().toggleCollapsed(dir)}
    >
      <span className="group-arrow" aria-hidden="true">▾</span>
      <span className="group-name">{dir === "" ? t("grid.rootGroup") : dir}</span>
      <button
        type="button"
        className="group-select"
        aria-label={t("grid.selectGroup")}
        onClick={(e) => onSelectGroup(e, dir)}
      >
        {t("grid.selectGroup")}
      </button>
      <span className="group-count">{t("grid.count", { n: total })}</span>
    </div>
  );
}
