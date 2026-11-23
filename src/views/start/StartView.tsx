import { useEffect } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { formatKey, IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import { loadRecents } from "../../stores/recents";
import RecentList from "./RecentList";
import "./start.css";

export default function StartView() {
  useEffect(() => {
    void loadRecents();
  }, []);
  return (
    <div className="start">
      <div className="start-column">
        <div className="start-hero">
          <div className="start-hint">{t("start.dropHint")}</div>
          <button type="button" className="start-open" onClick={() => void pickAndOpenFolder()}>
            {t("start.open")}
            <kbd>{formatKey("Mod+O", IS_MAC)}</kbd>
          </button>
        </div>
        <RecentList />
      </div>
    </div>
  );
}
