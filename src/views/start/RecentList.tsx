import type { SyntheticEvent } from "react";
import { openRecent } from "../../app/openFolder";
import { t } from "../../i18n";
import type { RecentEntry } from "../../ipc/types";
import { thumbKeyUrl } from "../../lib/glanceUrl";
import { pinRecent, removeRecent, useRecents } from "../../stores/recents";

const THUMB_SLOTS = 4;

/** 缩略图读不出：隐藏这张图，露出占位底色。 */
function hideOnError(e: SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.hidden = true;
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 2h4l-.5 4 2.5 2.5v1H9l-1 4.5-1-4.5H4v-1L6.5 6z" fill="currentColor" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RecentItem({ entry }: { entry: RecentEntry }) {
  const keys = entry.thumbs.slice(0, THUMB_SLOTS);
  const slots = Array.from({ length: THUMB_SLOTS }, (_, i) => keys[i]);
  return (
    <li className={entry.exists ? "recent-item" : "recent-item is-missing"}>
      <button
        type="button"
        className="recent-main"
        title={entry.path}
        disabled={!entry.exists}
        onClick={() => void openRecent(entry)}
      >
        <span className="recent-thumbs">
          {slots.map((key, i) => (
            <span key={i} className="recent-thumb">
              {key !== undefined && (
                <img src={thumbKeyUrl(key)} loading="lazy" alt="" draggable={false} onError={hideOnError} />
              )}
            </span>
          ))}
        </span>
        <span className="recent-text">
          <span className="recent-name">{entry.name}</span>
          <span className="recent-path">{entry.path}</span>
        </span>
        {entry.count !== null && <span className="recent-count">{t("start.count", { n: entry.count })}</span>}
      </button>
      <span className="recent-actions">
        {entry.exists && (
          <button
            type="button"
            className={entry.pinned ? "recent-action recent-pin is-pinned" : "recent-action recent-pin"}
            aria-pressed={entry.pinned}
            aria-label={t(entry.pinned ? "start.unpin" : "start.pin")}
            title={t(entry.pinned ? "start.unpin" : "start.pin")}
            onClick={() => void pinRecent(entry.path, !entry.pinned)}
          >
            <PinIcon />
          </button>
        )}
        <button
          type="button"
          className="recent-action recent-remove"
          aria-label={t("start.remove")}
          title={t("start.remove")}
          onClick={() => void removeRecent(entry.path)}
        >
          <RemoveIcon />
        </button>
      </span>
    </li>
  );
}

/** 最近目录列表：按 store 里的顺序（后端已把固定项排在前）。为空时不渲染。 */
export default function RecentList() {
  const list = useRecents((s) => s.list);
  if (list.length === 0) return null;
  return (
    <section className="recent">
      <h2 className="recent-title">{t("start.recent")}</h2>
      <ul className="recent-list">
        {list.map((e) => <RecentItem key={e.path} entry={e} />)}
      </ul>
    </section>
  );
}
