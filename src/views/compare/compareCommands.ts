import { registerCommands, type Command } from "../../app/commands";
import { useNav } from "../../stores/nav";
import {
  actualFocused,
  compareColumns,
  fitFocused,
  inPanel,
  moveFocus,
  moveFocused,
  movePanelFocus,
  openFocused,
  PANEL_COLUMNS,
  removeFocused,
  togglePanelFocused,
  togglePanelWithFocus,
  toggleSync,
  zoomFocused,
} from "./compareActions";
import { useCompareUi } from "../../stores/compareUi";
import { cancelActiveSort } from "./useCompareViewport";

const ZOOM_STEP = 1.25;

/** 键盘焦点不在按钮 / 输入控件上。 */
function noControlFocused(): boolean {
  if (typeof document === "undefined") return true;
  const el = document.activeElement;
  return !(el instanceof HTMLElement && /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
}

/** 忽略按住不放的自动重复（Esc、移出、打开、切换类命令）。 */
const once = (fn: () => void): Command["run"] => ({ repeat }) => {
  if (!repeat) fn();
};

/**
 * 焦点在添加面板里时不做事（按键仍被命令拦下，不落到 WebView 的默认行为）。
 * 在墙上执行前先取消进行中的排序拖动：这些命令会改顺序、移出格子或改缩放，拖动的预览会过时。
 */
const wallOnly = (run: Command["run"]): Command["run"] => (ctx) => {
  if (inPanel()) return;
  cancelActiveSort();
  run(ctx);
};

/** 方向键：墙上移动格子焦点（上下按列数），面板里移动面板焦点（上下按 3 列）。 */
const arrow = (dx: number, dy: number): Command["run"] => () => {
  if (inPanel()) movePanelFocus(dx + dy * PANEL_COLUMNS);
  else moveFocus(dx + dy * compareColumns());
};

/**
 * 对比视图的命令（篮子命令空格与 C 在对比视图里不响应：它们的 views 不含 compare）。
 * 同一批命令按焦点区域（compareUi.focusArea）分派：面板区里方向键、Enter、Esc 改为面板操作，其余只对墙的命令不响应。
 */
const compareCommands: Command[] = [
  // 方向键：按住时连续移动
  { id: "compare.focusLeft", title: "cmd.compare.focusLeft", category: "cmd.cat.compare", keys: ["ArrowLeft"], views: ["compare"], run: arrow(-1, 0) },
  { id: "compare.focusRight", title: "cmd.compare.focusRight", category: "cmd.cat.compare", keys: ["ArrowRight"], views: ["compare"], run: arrow(1, 0) },
  { id: "compare.focusUp", title: "cmd.compare.focusUp", category: "cmd.cat.compare", keys: ["ArrowUp"], views: ["compare"], run: arrow(0, -1) },
  { id: "compare.focusDown", title: "cmd.compare.focusDown", category: "cmd.cat.compare", keys: ["ArrowDown"], views: ["compare"], run: arrow(0, 1) },
  // Alt+方向键：与相邻格交换，按住时连续交换
  { id: "compare.moveLeft", title: "cmd.compare.moveLeft", category: "cmd.cat.compare", keys: ["Alt+ArrowLeft"], views: ["compare"], run: wallOnly(() => moveFocused(-1)) },
  { id: "compare.moveRight", title: "cmd.compare.moveRight", category: "cmd.cat.compare", keys: ["Alt+ArrowRight"], views: ["compare"], run: wallOnly(() => moveFocused(1)) },
  { id: "compare.moveUp", title: "cmd.compare.moveUp", category: "cmd.cat.compare", keys: ["Alt+ArrowUp"], views: ["compare"], run: wallOnly(() => moveFocused(-compareColumns())) },
  { id: "compare.moveDown", title: "cmd.compare.moveDown", category: "cmd.cat.compare", keys: ["Alt+ArrowDown"], views: ["compare"], run: wallOnly(() => moveFocused(compareColumns())) },
  // 键盘焦点在按钮、开关、下拉框上时 Enter 归那个控件（不拦默认行为）；面板区里等同空格
  {
    id: "compare.open",
    title: "cmd.compare.open",
    category: "cmd.cat.compare",
    keys: ["Enter"],
    views: ["compare"],
    when: noControlFocused,
    run: once(() => (inPanel() ? togglePanelFocused() : openFocused())),
  },
  // Delete 在对比视图里只表示移出，不删文件
  { id: "compare.remove", title: "cmd.compare.remove", category: "cmd.cat.compare", keys: ["Delete", "Backspace"], views: ["compare"], run: wallOnly(once(removeFocused)) },
  { id: "compare.zoomIn", title: "cmd.compare.zoomIn", category: "cmd.cat.compare", keys: ["+", "="], views: ["compare"], run: wallOnly(() => zoomFocused(ZOOM_STEP)) },
  { id: "compare.zoomOut", title: "cmd.compare.zoomOut", category: "cmd.cat.compare", keys: ["-"], views: ["compare"], run: wallOnly(() => zoomFocused(1 / ZOOM_STEP)) },
  { id: "compare.fit", title: "cmd.compare.fit", category: "cmd.cat.compare", keys: ["0"], views: ["compare"], run: wallOnly(once(fitFocused)) },
  { id: "compare.actual", title: "cmd.compare.actual", category: "cmd.cat.compare", keys: ["1"], views: ["compare"], run: wallOnly(once(actualFocused)) },
  { id: "compare.toggleSync", title: "cmd.compare.toggleSync", category: "cmd.cat.compare", keys: ["S"], views: ["compare"], run: wallOnly(once(toggleSync)) },
  // Tab：开合添加面板，打开时焦点进面板，收起时回墙
  { id: "compare.togglePanel", title: "cmd.compare.togglePanel", category: "cmd.cat.compare", keys: ["Tab"], views: ["compare"], run: once(togglePanelWithFocus) },
  {
    id: "compare.panelToggle",
    title: "cmd.compare.panelToggle",
    category: "cmd.cat.compare",
    keys: [" "],
    views: ["compare"],
    when: inPanel,
    run: once(togglePanelFocused),
  },
  {
    id: "compare.back",
    title: "cmd.compare.back",
    category: "cmd.cat.compare",
    keys: ["Escape"],
    views: ["compare"],
    // 面板区里先把焦点还给墙（面板保持打开）；长按 Esc 的自动重复不连退几层
    run: once(() => (inPanel() ? useCompareUi.getState().setFocusArea("wall") : useNav.getState().back())),
  },
];

/** 应用启动时注册一次；返回注销函数。 */
export function registerCompareCommands(): () => void {
  return registerCommands(compareCommands);
}
