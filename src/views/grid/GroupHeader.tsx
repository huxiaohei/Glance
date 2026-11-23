import { t } from "../../i18n";

interface Props { dir: string; total: number }

export default function GroupHeader({ dir, total }: Props) {
  return (
    <div className="group-header">
      <span className="group-name">{dir === "" ? t("grid.rootGroup") : dir}</span>
      <span className="group-count">{t("grid.count", { n: total })}</span>
    </div>
  );
}
