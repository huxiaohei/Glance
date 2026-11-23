import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useState } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { t } from "../../i18n";
import { deriveList, type ListOptions } from "../../lib/deriveList";
import { layoutGrid, type Row } from "../../lib/gridLayout";
import { useCatalog } from "../../stores/catalog";
import GroupHeader from "./GroupHeader";
import StatusBar from "./StatusBar";
import ThumbCell from "./ThumbCell";
import { useVisibleThumbs } from "./useVisibleThumbs";
import "./grid.css";

const CELL = 160;
const TIER = 320;
const PAD = 12; // 滚动区左右内边距
// Task 7 接入真实的排序/目录筛选状态
const LIST_OPTIONS: ListOptions = { sort: "name", includeSubdirs: true, dirFilter: null, collapsed: new Set() };

/** 最后一个 top <= y 的标题行下标（rows 按 top 升序）。 */
function pinnedHeader(rows: Row[], y: number): number {
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  while (found >= 0 && rows[found].kind !== "header") found--;
  return found;
}

export default function GridView() {
  const root = useCatalog((s) => s.root);
  const entries = useCatalog((s) => s.entries);
  const scanning = useCatalog((s) => s.scanning);
  const version = useCatalog((s) => s.version);

  // 派生列表按 catalog.version 缓存
  const list = useMemo(() => deriveList(entries.values(), LIST_OPTIONS), [version]);

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!scroller) return;
    const measure = () => setSize({ width: scroller.clientWidth, height: scroller.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller]);

  const layout = useMemo(() => layoutGrid(list, Math.max(0, size.width - PAD * 2), CELL), [list, size.width]);

  const virtualizer = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => scroller,
    // 行高加上到下一行的间距，使总高度恰为 layout.totalHeight
    estimateSize: (i) => {
      const next = layout.rows[i + 1];
      return next ? next.top - layout.rows[i].top : layout.rows[i].height;
    },
    overscan: 4,
  });
  const scrollTop = virtualizer.scrollOffset ?? 0;
  useVisibleThumbs(layout, scrollTop, size.height, TIER);

  const openOther = useCallback(() => void pickAndOpenFolder(), []);

  // 绝对定位的虚拟行里 sticky 不起作用：用一个零高度的 sticky 容器承载"当前分组标题"浮层，
  // 下一个标题顶上来时把它推出去。
  const pinned = pinnedHeader(layout.rows, scrollTop);
  const pinnedRow = pinned >= 0 ? layout.rows[pinned] : null;
  let push = 0;
  if (pinned >= 0) {
    for (let i = pinned + 1; i < layout.rows.length; i++) {
      const r = layout.rows[i];
      if (r.kind === "header") { push = Math.min(0, r.top - scrollTop - r.height); break; }
    }
  }

  const empty = !scanning && list.ids.length === 0;
  const total = list.groups.reduce((n, g) => n + g.total, 0);

  return (
    <div className="grid-view">
      <div className="grid-toolbar">
        <span className="grid-root" title={root?.path}>{root?.name}</span>
        {scanning && <span className="grid-scanning">{t("grid.scanning", { n: entries.size })}</span>}
        <span className="grid-spacer" />
        <button type="button" onClick={openOther}>{t("grid.openOther")}</button>
      </div>
      <div className="grid-progress">{scanning && <div className="grid-progress-bar" />}</div>
      {empty ? (
        <div className="grid-empty">
          <div>{t("grid.empty")}</div>
          <button type="button" onClick={openOther}>{t("grid.openOther")}</button>
        </div>
      ) : (
        <div className="grid-scroll" ref={setScroller}>
          <div className="grid-pin">
            {pinnedRow?.kind === "header" && (
              <div className="grid-pin-inner" style={{ transform: `translateY(${push}px)` }}>
                <GroupHeader dir={pinnedRow.dir} total={pinnedRow.total} />
              </div>
            )}
          </div>
          <div className="grid-canvas" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = layout.rows[v.index];
              if (!row) return null;
              return (
                <div
                  key={v.key}
                  className={row.kind === "header" ? "grid-row grid-row-header" : "grid-row"}
                  style={{ height: row.height, transform: `translateY(${row.top}px)` }}
                >
                  {row.kind === "header" ? (
                    <GroupHeader dir={row.dir} total={row.total} />
                  ) : (
                    row.ids.map((id) => {
                      const entry = entries.get(id);
                      return entry ? <ThumbCell key={id} entry={entry} cell={CELL} /> : null;
                    })
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <StatusBar total={total} />
    </div>
  );
}
