import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { actualSizeViewport, fitAllViewport, zoomAtCell } from "../../lib/compareViewport";
import { panelIds } from "../../lib/panelSource";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi } from "../../stores/compareUi";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSettings } from "../../stores/settings";
import { showToast } from "../../stores/toast";
import { compareLayout, flushCompareViewport, layoutCells } from "./useCompareViewport";

/** 篮子被移空 / 清空时退回进入前的视图（只在对比视图在栈顶时）。 */
export function backIfEmpty(): void {
  if (useBasket.getState().order.length === 0 && topView().kind === "compare") useNav.getState().back();
}

/**
 * 从对比篮移出 ids（移出按钮、Delete、“全部移出”共用）：焦点在被移出的格上时落到补位的那一格，
 * 没有则前一格；篮子空了退回进入前的视图。提示条“已移出对比”带撤销，撤销放回原位置（不重新进入对比）。
 */
export function removeFromCompare(ids: readonly FileId[]): void {
  const before = useBasket.getState().order;
  const gone = new Set(ids);
  const snap = useBasket.getState().remove([...gone]);
  const after = useBasket.getState().order;
  if (after === before) return;

  const oldFocus = useCompareUi.getState().focus;
  if (oldFocus !== null && gone.has(oldFocus)) refocusAfterRemoval(before, after);
  backIfEmpty();
  showToast({
    text: t("compare.removed"),
    actions: [
      {
        label: t("compare.undo"),
        run: () => {
          useBasket.getState().restore(snap);
          // 仍在对比里时焦点回到撤销前的那一格
          if (oldFocus !== null && gone.has(oldFocus) && topView().kind === "compare") {
            useCompareUi.getState().setFocus(oldFocus);
          }
        },
      },
    ],
  });
}

/**
 * 篮子从 before 变成 after 后，焦点若已不在 after 里：落到它在 before 里之后第一张还在的，
 * 没有则之前最后一张还在的（不在 before 里时落第一张）。对比视图里移出与在单张视图里移出共用。
 */
export function refocusAfterRemoval(before: readonly FileId[], after: readonly FileId[]): void {
  const ui = useCompareUi.getState();
  const focus = ui.focus;
  if (focus === null) return;
  const keep = new Set(after);
  if (keep.has(focus)) return;
  const i = before.indexOf(focus);
  const next = i < 0
    ? after[0]
    : before.slice(i + 1).find((id) => keep.has(id)) ?? before.slice(0, i).reverse().find((id) => keep.has(id));
  ui.setFocus(next ?? null);
}

/** 清空对比篮并退回进入前的视图；提示条带撤销，撤销把清掉的图放回原位置（其后新加的保留，不重新进入对比）。 */
export function clearCompare(): void {
  const snap = useBasket.getState().clear();
  if (snap.order.length === 0) return;
  backIfEmpty();
  showToast({
    text: t("compare.cleared"),
    actions: [{ label: t("compare.undo"), run: () => useBasket.getState().restore(snap) }],
  });
}

/** 焦点移动 delta 格（左右 ±1，上下 ± 列数）；越界不动。没有焦点时落在第一张。 */
export function moveFocus(delta: number): void {
  const order = useBasket.getState().order;
  if (order.length === 0) return;
  const ui = useCompareUi.getState();
  const i = ui.focus === null ? -1 : order.indexOf(ui.focus);
  if (i < 0) {
    ui.setFocus(order[0]);
    return;
  }
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  ui.setFocus(order[j]);
}

/** 焦点格与 index+delta 的格交换位置；越界不动，焦点仍是原图。 */
export function moveFocused(delta: number): void {
  const { focus } = useCompareUi.getState();
  if (focus === null) return;
  const { order, swap } = useBasket.getState();
  const i = order.indexOf(focus);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  swap(focus, order[j]);
}

/** 每排张数（上下移动的步长）。 */
export function compareColumns(): number {
  return useSettings.getState().settings.compareColumns;
}

/** 焦点格打开单张视图（缺失或不在篮内时不做事）。 */
export function openFocused(): void {
  const { focus } = useCompareUi.getState();
  const { order, missing } = useBasket.getState();
  if (focus === null || !order.includes(focus) || missing.has(focus)) return;
  flushCompareViewport();
  useNav.getState().openSingle(focus, "basket");
}

/** 移出焦点格。 */
export function removeFocused(): void {
  const { focus } = useCompareUi.getState();
  if (focus !== null && useBasket.getState().order.includes(focus)) removeFromCompare([focus]);
}

/** 以焦点格中心为锚缩放 factor 倍（同步开时以全部格定上下限，否则只看焦点格）。没有布局或尺寸未知时不做事。 */
export function zoomFocused(factor: number): void {
  flushCompareViewport();
  const layout = compareLayout();
  const ui = useCompareUi.getState();
  const id = ui.focus;
  if (!layout || id === null) return;
  const img = layout.sizes.get(id);
  const { box } = layout;
  if (!img || box.w <= 0 || box.h <= 0) return;
  const anchor = { img, box, px: box.w / 2, py: box.h / 2 };
  const cells = ui.perCell === null ? layoutCells(layout) : [{ img, box }];
  ui.updateViewport(id, (vp) => zoomAtCell(vp, factor, anchor, cells));
}

/** 适应格子：同步开时全部，否则焦点格。 */
export function fitFocused(): void {
  flushCompareViewport();
  const ui = useCompareUi.getState();
  if (ui.perCell === null) ui.commit(fitAllViewport(), null);
  else if (ui.focus !== null) ui.updateViewport(ui.focus, () => fitAllViewport());
}

/** 逐像素 100%：同步开时全部，否则焦点格。 */
export function actualFocused(): void {
  flushCompareViewport();
  const ui = useCompareUi.getState();
  if (ui.perCell === null) ui.commit(actualSizeViewport(ui.viewport), null);
  else if (ui.focus !== null) ui.updateViewport(ui.focus, actualSizeViewport);
}

/** 切换同步缩放（切回同步时对齐到焦点格）。 */
export function toggleSync(): void {
  flushCompareViewport();
  useCompareUi.getState().toggleSync();
}

// ---- 添加面板 ----

/** 每排张数（面板固定 3 列）。 */
export const PANEL_COLUMNS = 3;

let panelCache: { key: readonly unknown[]; ids: FileId[] } | null = null;

/**
 * 添加面板当前列出的图（与面板显示一致）：没打开目录时只有“其他文件夹”来源有图。
 * 按住方向键会连续调用：输入不变时取上次的结果。
 */
export function currentPanelIds(): FileId[] {
  const { root, entries, listVersion } = useCatalog.getState();
  const { sort, includeSubdirs } = useListView.getState();
  const source = useCompareUi.getState().panelSource;
  const key = [root, entries, listVersion, sort, includeSubdirs, source];
  if (panelCache && panelCache.key.every((v, i) => v === key[i])) return panelCache.ids;
  const ids = root === null && source.kind !== "other" ? [] : panelIds(entries, sort, includeSubdirs, source);
  panelCache = { key, ids };
  return ids;
}

/** 键盘焦点在添加面板里（面板开着）。 */
export function inPanel(): boolean {
  const ui = useCompareUi.getState();
  return ui.panelOpen && ui.focusArea === "panel";
}

/** Tab：打开面板并把焦点放进去（上次的位置，已不在面板里时第一张）；已打开则收起，焦点回墙。 */
export function togglePanelWithFocus(): void {
  const ui = useCompareUi.getState();
  if (ui.panelOpen) {
    ui.togglePanel();
    return;
  }
  ui.togglePanel();
  const ids = currentPanelIds();
  if (ui.panelFocus === null || !ids.includes(ui.panelFocus)) ui.setPanelFocus(ids[0] ?? null);
  ui.setFocusArea("panel");
}

/** 面板焦点移动 delta 格（左右 ±1，上下 ±3）；越界不动。焦点不在当前列表里时落在第一张。 */
export function movePanelFocus(delta: number): void {
  const ids = currentPanelIds();
  if (ids.length === 0) return;
  const ui = useCompareUi.getState();
  const i = ui.panelFocus === null ? -1 : ids.indexOf(ui.panelFocus);
  if (i < 0) {
    ui.setPanelFocus(ids[0]);
    return;
  }
  const j = i + delta;
  if (j < 0 || j >= ids.length) return;
  ui.setPanelFocus(ids[j]);
}

/** 把面板里的一张加入 / 移出对比篮：其他文件夹的条目不在 catalog 里，用扫描时的快照。 */
export function togglePanelItem(id: FileId): void {
  const source = useCompareUi.getState().panelSource;
  const it = source.kind === "other" ? source.items.find((x) => x.id === id) : undefined;
  if (it) useBasket.getState().toggleItems([it]);
  else useBasket.getState().toggle([id]);
}

/** 空格 / Enter（面板区）：切换面板焦点那张的加入状态。 */
export function togglePanelFocused(): void {
  const { panelFocus } = useCompareUi.getState();
  if (panelFocus !== null && currentPanelIds().includes(panelFocus)) togglePanelItem(panelFocus);
}
