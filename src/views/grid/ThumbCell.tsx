import { memo } from "react";
import { t } from "../../i18n";
import type { ImageEntry } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { middleEllipsis } from "../../lib/middleEllipsis";
import { useThumbs } from "../../stores/thumbs";

interface Props { entry: ImageEntry; cell: number }

/** 文件名按 12px 字体粗略估算每格能放下的字符数。 */
const nameChars = (cell: number) => Math.max(8, Math.floor(cell / 7));

function ThumbCell({ entry, cell }: Props) {
  const tier = useThumbs((s) => s.ready.get(entry.id));
  const broken = useThumbs((s) => s.broken.has(entry.id));
  const { width, height } = entry;

  let placeholder: { width: number; height: number } | null = null;
  if (width && height) {
    const k = Math.min(cell / width, cell / height);
    placeholder = { width: width * k, height: height * k };
  }

  return (
    <div className="thumb-cell" style={{ width: cell }}>
      <div className="thumb-box" style={{ width: cell, height: cell }}>
        {broken ? (
          <div className="thumb-broken">{t("grid.unreadable")}</div>
        ) : tier ? (
          <img
            className="thumb-img"
            src={glanceUrl(`thumb/${entry.id}/${tier}?v=${entry.mtimeMs}-${entry.size}`)}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="thumb-placeholder" style={placeholder ?? { width: "100%", height: "100%" }} />
        )}
      </div>
      <div className="thumb-name" title={entry.name}>
        {middleEllipsis(entry.name, nameChars(cell))}
      </div>
    </div>
  );
}

export default memo(ThumbCell);
