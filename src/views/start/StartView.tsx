import { pickAndOpenFolder, useOpenError } from "../../app/openFolder";
import { t } from "../../i18n";
import "./start.css";

export default function StartView() {
  const error = useOpenError((s) => s.error);
  return (
    <div className="start">
      <div>{t("start.dropHint")}</div>
      <button type="button" onClick={() => void pickAndOpenFolder()}>
        {t("start.open")}
      </button>
      {error && <div className="start-error">{t(`error.${error}`)}</div>}
    </div>
  );
}
