import { memo, useState } from "react";
import { t } from "../../i18n";
import type { ImageEntry } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { middleEllipsis } from "../../lib/middleEllipsis";
import { useThumbs } from "../../stores/thumbs";

interface Props { entry: ImageEntry; cell: number }

/** 12px 字体下窄字符约 6.5px、全角约 13px：按窄字符单位估算每格预算。 */
const nameBudget = (cell: number) => Math.max(8, Math.floor(cell / 6.5));

function ThumbCell({ entry, cell }: Props) {
  const ready = useThumbs((s) => s.ready.get(entry.id));
  const broken = useThumbs((s) => s.broken.has(entry.id));
  const { width, height } = entry;
  // 版本号来自后端生成这张缩略图时读到的文件状态
  const src = ready ? glanceUrl(`thumb/${entry.id}/${ready.tier}?v=${ready.v}`) : null;
  // 扫描后文件被改动或删除时协议返回 404：这张缩略图加载失败，改显占位
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

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
        ) : src && failedSrc !== src ? (
          <img
            className="thumb-img"
            src={src}
            alt=""
            onError={() => setFailedSrc(src)}
            draggable={false}
          />
        ) : (
          <div className="thumb-placeholder" style={placeholder ?? { width: "100%", height: "100%" }} />
        )}
      </div>
      <div className="thumb-name" title={entry.name}>
        {middleEllipsis(entry.name, nameBudget(cell))}
      </div>
    </div>
  );
}

export default memo(ThumbCell);
