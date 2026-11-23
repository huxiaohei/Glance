import { useEffect, useRef, useState } from "react";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { useCatalog } from "../../stores/catalog";
import { useSingleUi } from "../../stores/singleUi";
import { backToGrid, singleCommand } from "./singleCommands";

/** 切到另一个子目录时目录名高亮这么久。 */
const DIR_HIGHLIGHT_MS = 1000;

/** 单张视图顶栏：返回按钮 + “子目录 / 文件名”。当前图所在目录与上一张不同时目录名高亮 1 秒。 */
export default function TopBar({ id }: { id: FileId }) {
  const entry = useCatalog((s) => s.entries.get(id));
  const dir = entry?.dir;

  const [changed, setChanged] = useState(false);
  const prevDir = useRef<string | undefined>(dir);
  useEffect(() => {
    const prev = prevDir.current;
    prevDir.current = dir;
    if (dir === undefined || prev === undefined || prev === dir) return;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), DIR_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [dir]);

  const cmd = singleCommand("single.back");
  const tip = cmd ? `${t(cmd.title)} (${formatKey(cmd.keys[0], IS_MAC)})` : t("single.back");

  const infoOpen = useSingleUi((s) => s.infoOpen);
  const infoCmd = singleCommand("single.toggleInfo");
  const infoTip = infoCmd ? `${t(infoCmd.title)} (${formatKey(infoCmd.keys[0], IS_MAC)})` : t("details.title");

  return (
    <div className="single-topbar">
      <button type="button" className="topbar-back" title={tip} aria-label={t("single.back")} onClick={backToGrid}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      {entry && (
        <div className="topbar-path">
          {entry.dir !== "" && (
            <>
              <span className={`topbar-dir${changed ? " dir-changed" : ""}`}>{entry.dir}</span>
              <span className="topbar-sep">/</span>
            </>
          )}
          <span className="topbar-name" title={entry.name}>
            {entry.name}
          </span>
        </div>
      )}
      <button
        type="button"
        className={`topbar-info${infoOpen ? " active" : ""}`}
        title={infoTip}
        aria-label={t("details.title")}
        aria-pressed={infoOpen}
        onClick={() => useSingleUi.getState().toggleInfo()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.5" />
        </svg>
      </button>
    </div>
  );
}
