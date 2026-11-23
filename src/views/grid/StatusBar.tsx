import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";

export default function StatusBar({ total }: { total: number }) {
  const watchFailed = useCatalog((s) => s.watchFailed);
  return (
    <div className="status-bar">
      <span>{t("grid.total", { n: total })}</span>
      {watchFailed && <span className="status-warn">{t("status.watchFailed")}</span>}
    </div>
  );
}
