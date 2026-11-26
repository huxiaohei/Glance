import { useHelp } from "../../app/useKeyboard";
import { useEffect, useState } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { formatKey, IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import { appVersion } from "../../ipc/api";
import { loadRecents } from "../../stores/recents";
import { useTip } from "../../stores/tip";
import tigerPeek from "../../assets/tip/tiger_peek.webp";
import tigerBlink from "../../assets/tip/tiger_peek_blink.webp";
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
        <button type="button" className="start-help" onClick={() => useHelp.setState({ open: true })}>
          {t("help.open")}
        </button>
        {version !== null && <span className="start-version">v{version}</span>}
      </div>
      {/* 小老虎趴在窗口底边：隔一阵探头、歪头、冒爱心，平时眨眨眼；没有文字，读屏用 aria-label；点它打开打赏大图 */}
      <button
        type="button"
        className="start-peek"
        aria-label={t("tip.title")}
        onClick={() => useTip.setState({ open: true })}
      >
        <span className="start-peek-body">
          <img className="start-peek-tiger" src={tigerPeek} alt="" draggable={false} />
          <img className="start-peek-blink" src={tigerBlink} alt="" draggable={false} />
          <svg className="start-peek-heart" viewBox="0 0 32 30" aria-hidden="true">
            <path
              d="M16 28 C 6 20 2 15 2 9.5 A 7 7 0 0 1 16 6.5 A 7 7 0 0 1 30 9.5 C 30 15 26 20 16 28 Z"
              fill="#F28C8C"
              stroke="#3A2B2E"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
    </div>
  );
}
