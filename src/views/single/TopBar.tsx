import { useEffect, useRef, useState } from "react";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { useCatalog } from "../../stores/catalog";
import { startRename, useRename } from "../../stores/rename";
import { useSingleUi } from "../../stores/singleUi";
import RenameInput from "../common/RenameInput";
import { backToGrid, singleCommand } from "./singleCommands";

/** 切到另一个子目录时目录名高亮这么久。 */
const DIR_HIGHLIGHT_MS = 1000;

/** 单张视图顶栏：返回按钮 + “子目录 / 文件名”。当前图所在目录与上一张不同时目录名高亮 1 秒。 */
export default function TopBar({ id }: { id: FileId }) {
  const entry = useCatalog((s) => s.entries.get(id));
  const renaming = useRename((s) => s.id === id);
  const dir = entry?.dir;

  // 目录一时取不到（条目暂缺）时什么都不动：不覆盖上一次的目录，也不清掉正在走的计时
  const [changed, setChanged] = useState(false);
  const prevDir = useRef<string | undefined>(dir);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (dir === undefined) return;
    const prev = prevDir.current;
    prevDir.current = dir;
    if (prev === undefined || prev === dir) return;
    setChanged(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setChanged(false), DIR_HIGHLIGHT_MS);
  }, [dir]);
  useEffect(() => () => clearTimeout(timer.current), []);

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
          {renaming ? (
            <RenameInput id={id} name={entry.name} />
          ) : (
            <span className="topbar-name" title={entry.name} onDoubleClick={() => startRename(id)}>
              {entry.name}
            </span>
          )}
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
