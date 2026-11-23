import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { t } from "../../i18n";
import { deriveList, dirTree } from "../../lib/deriveList";
import { layoutGrid, type Row } from "../../lib/gridLayout";
import { pickTier } from "../../lib/pickTier";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import DirTree from "./DirTree";
import GridToolbar from "./GridToolbar";
import GroupHeader from "./GroupHeader";
import StatusBar from "./StatusBar";
import ThumbCell from "./ThumbCell";
import { useVisibleThumbs } from "./useVisibleThumbs";
import "./grid.css";

const PAD = 12; // 滚动区左右内边距
const WHEEL_STEP = 16; // Cmd/Ctrl + 滚轮每格调整的格子大小

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
  const sort = useListView((s) => s.sort);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const dirFilter = useListView((s) => s.dirFilter);
  const collapsed = useListView((s) => s.collapsed);
  const cell = useListView((s) => s.cell);
  const generation = root?.generation;
  const tier = pickTier(cell, window.devicePixelRatio);

  // 派生列表与目录树按 catalog.version（及各选项）缓存，滚动和缩略图事件不会触发重算
  const list = useMemo(
    () => deriveList(entries.values(), { sort, includeSubdirs, dirFilter, collapsed }),
    [version, sort, includeSubdirs, dirFilter, collapsed],
  );
  const tree = useMemo(() => dirTree(entries.values()), [version]);

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

  const layout = useMemo(() => layoutGrid(list, Math.max(0, size.width - PAD * 2), cell), [list, size.width]);

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
  // estimateSize 不在虚拟器的缓存依赖里：布局变化（换目录、列数变化）后须手动让它重算
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, layout]);
  // 排序、筛选、折叠、格子大小变化不回到顶部，只有换根目录才回到顶部
  useLayoutEffect(() => {
    if (scroller) scroller.scrollTop = 0;
  }, [scroller, generation]);
  const scrollTop = virtualizer.scrollOffset ?? 0;
  useVisibleThumbs(layout, scrollTop, size.height, tier);

  // Cmd/Ctrl + 滚轮调格子大小。React 的 onWheel 是被动监听，preventDefault 拦不住页面缩放，须手动挂非被动监听。
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const { cell: cur, setCell } = useListView.getState();
      setCell(cur + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [scroller]);

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

  const empty = !scanning && list.groups.length === 0;
  const total = list.groups.reduce((n, g) => n + g.total, 0);
  // 不含子目录时列表为空，但当前范围内其实有下级图片：提示打开“包含子目录”
  const hintSubdirs = empty && !includeSubdirs &&
    (dirFilter === null ? tree.length > 0 : tree.some((n) => n.dir === dirFilter && n.total > n.count));

  return (
    <div className="grid-view">
      <GridToolbar />
      <div className="grid-progress">{scanning && <div className="grid-progress-bar" />}</div>
      <div className="grid-body">
        <DirTree nodes={tree} total={entries.size} />
        <div className="grid-main">
          {empty ? (
            <div className="grid-empty">
              <div>{t("grid.empty")}</div>
              {hintSubdirs && <div>{t("grid.emptyHintSubdirs")}</div>}
              <button type="button" onClick={openOther}>{t("grid.openOther")}</button>
            </div>
          ) : (
            <div className="grid-scroll" ref={setScroller}>
              <div className="grid-pin">
                {pinnedRow?.kind === "header" && (
                  <div className="grid-pin-inner" style={{ transform: `translateY(${push}px)` }}>
                    <GroupHeader dir={pinnedRow.dir} total={pinnedRow.total} collapsed={pinnedRow.count !== pinnedRow.total} />
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
                        <GroupHeader dir={row.dir} total={row.total} collapsed={row.count !== row.total} />
                      ) : (
                        row.ids.map((id) => {
                          const entry = entries.get(id);
                          return entry ? <ThumbCell key={id} entry={entry} cell={cell} /> : null;
                        })
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <StatusBar total={total} />
    </div>
  );
}
