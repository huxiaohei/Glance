import { registerCommands, type Command } from "../../app/commands";
import { useNav } from "../../stores/nav";
import {
  actualFocused,
  compareColumns,
  fitFocused,
  moveFocus,
  moveFocused,
  openFocused,
  removeFocused,
  toggleSync,
  zoomFocused,
} from "./compareActions";

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

/** 对比视图的命令（空格与 C 在对比视图里不响应：它们的 views 不含 compare）。 */
const compareCommands: Command[] = [
  // 方向键：按住时连续移动
  { id: "compare.focusLeft", title: "cmd.compare.focusLeft", category: "cmd.cat.compare", keys: ["ArrowLeft"], views: ["compare"], run: () => moveFocus(-1) },
  { id: "compare.focusRight", title: "cmd.compare.focusRight", category: "cmd.cat.compare", keys: ["ArrowRight"], views: ["compare"], run: () => moveFocus(1) },
  { id: "compare.focusUp", title: "cmd.compare.focusUp", category: "cmd.cat.compare", keys: ["ArrowUp"], views: ["compare"], run: () => moveFocus(-compareColumns()) },
  { id: "compare.focusDown", title: "cmd.compare.focusDown", category: "cmd.cat.compare", keys: ["ArrowDown"], views: ["compare"], run: () => moveFocus(compareColumns()) },
  // Alt+方向键：与相邻格交换，按住时连续交换
  { id: "compare.moveLeft", title: "cmd.compare.moveLeft", category: "cmd.cat.compare", keys: ["Alt+ArrowLeft"], views: ["compare"], run: () => moveFocused(-1) },
  { id: "compare.moveRight", title: "cmd.compare.moveRight", category: "cmd.cat.compare", keys: ["Alt+ArrowRight"], views: ["compare"], run: () => moveFocused(1) },
  { id: "compare.moveUp", title: "cmd.compare.moveUp", category: "cmd.cat.compare", keys: ["Alt+ArrowUp"], views: ["compare"], run: () => moveFocused(-compareColumns()) },
  { id: "compare.moveDown", title: "cmd.compare.moveDown", category: "cmd.cat.compare", keys: ["Alt+ArrowDown"], views: ["compare"], run: () => moveFocused(compareColumns()) },
  // 键盘焦点在按钮、开关、下拉框上时 Enter 归那个控件（不拦默认行为）
  { id: "compare.open", title: "cmd.compare.open", category: "cmd.cat.compare", keys: ["Enter"], views: ["compare"], when: noControlFocused, run: once(openFocused) },
  // Delete 在对比视图里只表示移出，不删文件
  { id: "compare.remove", title: "cmd.compare.remove", category: "cmd.cat.compare", keys: ["Delete", "Backspace"], views: ["compare"], run: once(removeFocused) },
  { id: "compare.zoomIn", title: "cmd.compare.zoomIn", category: "cmd.cat.compare", keys: ["+", "="], views: ["compare"], run: () => zoomFocused(ZOOM_STEP) },
  { id: "compare.zoomOut", title: "cmd.compare.zoomOut", category: "cmd.cat.compare", keys: ["-"], views: ["compare"], run: () => zoomFocused(1 / ZOOM_STEP) },
  { id: "compare.fit", title: "cmd.compare.fit", category: "cmd.cat.compare", keys: ["0"], views: ["compare"], run: once(fitFocused) },
  { id: "compare.actual", title: "cmd.compare.actual", category: "cmd.cat.compare", keys: ["1"], views: ["compare"], run: once(actualFocused) },
  { id: "compare.toggleSync", title: "cmd.compare.toggleSync", category: "cmd.cat.compare", keys: ["S"], views: ["compare"], run: once(toggleSync) },
  {
    id: "compare.back",
    title: "cmd.compare.back",
    category: "cmd.cat.compare",
    keys: ["Escape"],
    views: ["compare"],
    // 长按 Esc 的自动重复不连退几层
    run: once(() => useNav.getState().back()),
  },
];

/** 应用启动时注册一次；返回注销函数。 */
export function registerCompareCommands(): () => void {
  return registerCommands(compareCommands);
}
