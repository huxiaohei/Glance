import { t } from "../../i18n";

export default function StatusBar({ total }: { total: number }) {
  return <div className="status-bar">{t("grid.total", { n: total })}</div>;
}
