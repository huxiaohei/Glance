import { memo, useState, type PointerEvent } from "react";
import { IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import type { ImageEntry } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { middleEllipsis } from "../../lib/middleEllipsis";
import { selectOnly, selectRange, toggle } from "../../lib/selection";
import { useGridCtx } from "../../stores/gridCtx";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";

interface Props { entry: ImageEntry; cell: number; selected: boolean; focused: boolean }

/**
 * 按下主键时选中：单击只选它，Mod + 单击切换，Shift + 单击从锚点连选。
 * 右键（以及 macOS 上等同右键的 Ctrl + 单击）暂不改变选中。
 * 模块级函数、id 取自 data-id：所有格子共用同一个处理函数，不破坏 memo。
 */
function onCellPointerDown(e: PointerEvent<HTMLDivElement>): void {
  if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return;
  const id = Number(e.currentTarget.dataset.id);
  const sel = useSelection.getState();
  if (e.shiftKey) sel.set(selectRange(sel, useGridCtx.getState().list, id));
  else if (IS_MAC ? e.metaKey : e.ctrlKey) sel.set(toggle(sel, id));
  else sel.set(selectOnly(id));
}

/** 12px 字体下窄字符约 6.5px、全角约 13px：按窄字符单位估算每格预算。 */
const nameBudget = (cell: number) => Math.max(8, Math.floor(cell / 6.5));

function ThumbCell({ entry, cell, selected, focused }: Props) {
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
    <div
      className={`thumb-cell${selected ? " thumb-selected" : ""}${focused ? " thumb-focused" : ""}`}
      style={{ width: cell }}
      data-id={entry.id}
      onPointerDown={onCellPointerDown}
    >
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
