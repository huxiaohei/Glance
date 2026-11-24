import { useEffect, useState } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { formatKey, IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import { appVersion } from "../../ipc/api";
import { loadRecents } from "../../stores/recents";
import { useTip } from "../../stores/tip";
import tigerPeek from "../../assets/tip/tiger_peek.webp";
import RecentList from "./RecentList";
import "./start.css";

export default function StartView() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void loadRecents();
    let alive = true;
    // 取不到版本号就不显示
    appVersion()
      .then((v) => alive && typeof v === "string" && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="start">
      <div className="start-column">
        <div className="start-hero">
          <div className="start-hint">{t("start.dropHint")}</div>
          <button type="button" className="start-open" onClick={() => void pickAndOpenFolder()}>
            {t("start.open")}
            <kbd aria-hidden="true">{formatKey("Mod+O", IS_MAC)}</kbd>
          </button>
        </div>
        <RecentList />
      </div>
      <div className="start-footer">
        {version !== null && <span className="start-version">v{version}</span>}
      </div>
      {/* 小老虎从窗口底边探头：一眼能看到打赏，点它打开大图 */}
      <button type="button" className="start-peek" onClick={() => useTip.setState({ open: true })}>
        <span className="start-peek-bubble">{t("tip.title")}</span>
        <img className="start-peek-tiger" src={tigerPeek} alt="" draggable={false} />
      </button>
    </div>
  );
}
