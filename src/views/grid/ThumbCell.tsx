import { memo, useState, type MouseEvent, type PointerEvent } from "react";
import { showImageMenu } from "../../app/contextMenu";
import { IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import type { ImageEntry } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { middleEllipsis } from "../../lib/middleEllipsis";
import { selectForContext, selectOnly, selectRange, toggle } from "../../lib/selection";
import { selectModifier } from "../../lib/thumbDrag";
import { useDrag } from "../../stores/drag";
import { useGridCtx } from "../../stores/gridCtx";
import { useNav } from "../../stores/nav";
import { startRename, useRename } from "../../stores/rename";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import RenameInput from "../common/RenameInput";

interface Props { entry: ImageEntry; cell: number; selected: boolean; focused: boolean }

/**
 * 按下主键时选中：单击只选它，Mod + 单击切换，Shift + 单击从锚点连选。
 * 不带修饰键（selectModifier，与 useThumbDrag 同一条）按在已选多张之一上时选中不变、只移焦点（可能要把它们一起拖走）；
 * 没拖就松手时由 useThumbDrag 收成只选它。拖拽进行中别的指针按下不改选中。
 * 右键（以及 macOS 上等同右键的 Ctrl + 单击）在 contextmenu 事件里处理，这里不管。
 * 模块级函数、id 取自 data-id：所有格子共用同一个处理函数，不破坏 memo。
 */
function onCellPointerDown(e: PointerEvent<HTMLDivElement>): void {
  if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return;
  if (useDrag.getState().count > 0) return;
  const id = Number(e.currentTarget.dataset.id);
  const sel = useSelection.getState();
  if (e.shiftKey) sel.set(selectRange(sel, useGridCtx.getState().list, id));
  else if (IS_MAC ? e.metaKey : e.ctrlKey) sel.set(toggle(sel, id));
  else if (!selectModifier(e) && sel.ids.has(id) && sel.ids.size > 1) sel.set(selectForContext(sel, id));
  else sel.set(selectOnly(id));
}

/** 右键（含 macOS 的 Ctrl + 单击）：先调整选中再弹菜单，并阻止系统默认菜单。重命名输入框里保持系统菜单。 */
function onCellContextMenu(e: MouseEvent<HTMLDivElement>): void {
  if ((e.target as Element).closest(".rename-input")) return;
  e.preventDefault();
  const sel = useSelection.getState();
  sel.set(selectForContext(sel, Number(e.currentTarget.dataset.id)));
  void showImageMenu();
}

/** 主键双击进入单张视图；按着 Mod、Ctrl 或 Shift 时只是选择操作，不进入。 */
function onCellDoubleClick(e: MouseEvent<HTMLDivElement>): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  useNav.getState().openSingle(Number(e.currentTarget.dataset.id));
}

/** 主键双击文件名开始重命名，不进入单张视图；按着修饰键时不处理（交给格子，只是选择操作）。 */
function onNameDoubleClick(e: MouseEvent<HTMLDivElement>): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.stopPropagation();
  const cell = e.currentTarget.closest<HTMLElement>("[data-id]");
  if (cell) startRename(Number(cell.dataset.id));
}

/** 12px 字体下窄字符约 6.5px、全角约 13px：按窄字符单位估算每格预算。 */
const nameBudget = (cell: number) => Math.max(8, Math.floor(cell / 6.5));

function ThumbCell({ entry, cell, selected, focused }: Props) {
  const ready = useThumbs((s) => s.ready.get(entry.id));
  const broken = useThumbs((s) => s.broken.has(entry.id));
  // 只让正在重命名的那一格重新渲染
  const renaming = useRename((s) => s.id === entry.id);
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
      onDoubleClick={onCellDoubleClick}
      onContextMenu={onCellContextMenu}
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
      {renaming ? (
        <div className="thumb-name thumb-name-editing">
          <RenameInput id={entry.id} name={entry.name} />
        </div>
      ) : (
        <div className="thumb-name" title={entry.name} onDoubleClick={onNameDoubleClick}>
          {middleEllipsis(entry.name, nameBudget(cell))}
        </div>
      )}
    </div>
  );
}

export default memo(ThumbCell);
