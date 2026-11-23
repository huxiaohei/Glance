import { t } from "../../i18n";
import { useListView } from "../../stores/listView";

interface Props { dir: string; total: number; collapsed: boolean }

export default function GroupHeader({ dir, total, collapsed }: Props) {
  return (
    <div
      className={collapsed ? "group-header group-header-collapsed" : "group-header"}
      onClick={() => useListView.getState().toggleCollapsed(dir)}
    >
      <span className="group-arrow" aria-hidden="true">▾</span>
      <span className="group-name">{dir === "" ? t("grid.rootGroup") : dir}</span>
      <span className="group-count">{t("grid.count", { n: total })}</span>
    </div>
  );
}
