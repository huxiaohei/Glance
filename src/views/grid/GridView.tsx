import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pickAndOpenFolder } from "../../app/openFolder";
import { useImageList } from "../../app/useImageList";
import { t } from "../../i18n";
import { dirTree } from "../../lib/deriveList";
import { GRID_PAD, HEADER_HEIGHT, layoutGrid, rowIndexOf, type Row } from "../../lib/gridLayout";
import { selectOnly } from "../../lib/selection";
import { accumulateWheel } from "../../lib/wheelZoom";
import { pickTier } from "../../lib/pickTier";
import { useCatalog } from "../../stores/catalog";
import { EMPTY_GRID_CTX, useGridCtx } from "../../stores/gridCtx";
import { useListView } from "../../stores/listView";
import { useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import DirTree from "./DirTree";
import GridToolbar from "./GridToolbar";
import GroupHeader from "./GroupHeader";
import { registerGridCommands } from "./gridCommands";
import StatusBar from "./StatusBar";
import ThumbCell from "./ThumbCell";
import { useMarquee } from "./useMarquee";
import { useVisibleThumbs } from "./useVisibleThumbs";
import "./grid.css";

const WHEEL_STEP = 16; // Cmd/Ctrl + 滚轮每累积一格调整的格子大小

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

/** hidden：单张视图盖在上面。只隐藏（visibility + pointer-events），不卸载，虚拟器与滚动位置保留。 */
export default function GridView({ hidden = false }: { hidden?: boolean }) {
  const root = useCatalog((s) => s.root);
  const entries = useCatalog((s) => s.entries);
  const scanning = useCatalog((s) => s.scanning);
  const listVersion = useCatalog((s) => s.listVersion);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const dirFilter = useListView((s) => s.dirFilter);
  const cell = useListView((s) => s.cell);
  const selectedIds = useSelection((s) => s.ids);
  const focusId = useSelection((s) => s.focus);
  const rootPath = root?.path;
  const tier = pickTier(cell, window.devicePixelRatio);

  // 目录树按 catalog.listVersion 缓存；滚动、缩略图事件和尺寸补全不会触发重算
  const list = useImageList();
  const tree = useMemo(() => dirTree(entries.values()), [listVersion]);

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

  const layout = useMemo(() => layoutGrid(list, Math.max(0, size.width - GRID_PAD * 2), cell), [list, size.width, cell]);

  const virtualizer = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => scroller,
    // 行高加上到下一行的间距，使总高度恰为 layout.totalHeight
    estimateSize: (i) => {
      const next = layout.rows[i + 1];
      return next ? next.top - layout.rows[i].top : layout.rows[i].height;
    },
    overscan: 4,
    scrollPaddingStart: HEADER_HEIGHT, // 滚入可见范围时不被吸顶的分组标题挡住
  });
  // estimateSize 不在虚拟器的缓存依赖里：布局变化（换目录、列数变化）后须手动让它重算
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, layout]);
  // 列表与布局发布给命令与指针处理（它们不各自派生列表）
  useLayoutEffect(() => {
    useGridCtx.setState({
      list,
      layout,
      reveal: (id) => {
        const i = rowIndexOf(layout, id);
        if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
      },
    });
  }, [list, layout, virtualizer]);
  useLayoutEffect(() => () => useGridCtx.setState(EMPTY_GRID_CTX), []);
  useEffect(() => registerGridCommands(), []);

  // 打开单张图片：该条目到达且已在布局里后，选中并滚到它，并进入单张视图（每次打开 generation 只做一次）。
  // 扫描期间后到的批次可能排在它前面、把它挤出视口：布局每次变化都再滚一次，扫描结束时再滚最后一次。
  // 用户一接手（在滚动区滚轮或按下指针，或选中不再恰好是这张）就停止，本次打开不再跟随。
  const follow = useRef<{ generation: number; active: boolean } | null>(null);
  useEffect(() => {
    if (!scroller) return;
    const stop = () => { if (follow.current) follow.current.active = false; };
    scroller.addEventListener("wheel", stop, { passive: true });
    scroller.addEventListener("pointerdown", stop);
    return () => {
      scroller.removeEventListener("wheel", stop);
      scroller.removeEventListener("pointerdown", stop);
    };
  }, [scroller]);
  useEffect(() => {
    if (!root || root.focus === null) return;
    const id = root.focus;
    if (size.height === 0 || !entries.has(id) || rowIndexOf(layout, id) < 0) return;
    const f = follow.current;
    if (f?.generation !== root.generation) {
      follow.current = { generation: root.generation, active: scanning };
      useSelection.getState().set(selectOnly(id));
      useGridCtx.getState().reveal(id);
      useNav.getState().openSingle(id);
      return;
    }
    if (!f.active) return;
    const sel = useSelection.getState();
    if (sel.focus !== id || sel.ids.size !== 1 || !sel.ids.has(id)) {
      f.active = false;
      return;
    }
    useGridCtx.getState().reveal(id);
    if (!scanning) f.active = false;
  }, [root, entries, layout, size.height, scanning]);
  // 排序、筛选、折叠、格子大小变化与刷新（同一路径重新打开）都不回到顶部，只有换根目录才回到顶部
  useLayoutEffect(() => {
    if (scroller) scroller.scrollTop = 0;
  }, [scroller, rootPath]);
  const scrollTop = virtualizer.scrollOffset ?? 0;
  useVisibleThumbs(layout, scrollTop, size.height, tier);
  // 空白处的指针处理（单击清空、框选）都在这里
  const marquee = useMarquee(scroller, layout, cell, !hidden);

  // Cmd/Ctrl + 滚轮调格子大小。React 的 onWheel 是被动监听，preventDefault 拦不住页面缩放，须手动挂非被动监听。
  const wheelAcc = useRef(0);
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      // 触控板捏合会连发大量小增量事件：累积满一格（100）才走一步
      const { acc, steps } = accumulateWheel(wheelAcc.current, e.deltaY, e.deltaMode);
      wheelAcc.current = acc;
      const dir = Math.sign(steps);
      for (let i = 0; i < Math.abs(steps); i++) {
        const { cell: cur, setCell } = useListView.getState();
        setCell(cur + dir * WHEEL_STEP);
      }
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
    <div className={hidden ? "grid-view grid-hidden" : "grid-view"}>
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
                          return entry ? (
                            <ThumbCell
                              key={id}
                              entry={entry}
                              cell={cell}
                              selected={selectedIds.has(id)}
                              focused={focusId === id}
                            />
                          ) : null;
                        })
                      )}
                    </div>
                  );
                })}
                {marquee && (
                  <div
                    className="grid-marquee"
                    style={{
                      left: GRID_PAD + Math.min(marquee.x0, marquee.x1),
                      top: Math.min(marquee.y0, marquee.y1),
                      width: Math.abs(marquee.x1 - marquee.x0),
                      height: Math.abs(marquee.y1 - marquee.y0),
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <StatusBar total={total} />
    </div>
  );
}
