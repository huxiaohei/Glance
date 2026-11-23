import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import { useSelection } from "../../stores/selection";

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
    </div>
  );
}
