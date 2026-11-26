import { enterBatch } from "../../app/batchMode";
import { registerCommands, type Command, type CommandCtx } from "../../app/commands";
import { opTargets } from "../../app/fileOps";
import { moveInLayout, type Move } from "../../lib/gridLayout";
import { moveTo, selectAll } from "../../lib/selection";
import { useBatch } from "../../stores/batch";
import { useGridCtx } from "../../stores/gridCtx";
import { useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import type { EditTab } from "../../ipc/types";
import { enterEdit } from "../edit/editCommands";

/** 没有焦点（或焦点不在当前布局里）时落到第一张；否则按布局移动。extend 时从锚点扩展选中。 */
function navigate(move: Move, ctx: CommandCtx): void {
  const { list, layout, reveal } = useGridCtx.getState();
  if (list.ids.length === 0) return;
  const sel = useSelection.getState();
  const moved = sel.focus === null ? null : moveInLayout(layout, list, sel.focus, move);
  const target = moved ?? list.ids[0];
  sel.set(moveTo(sel, list, target, ctx.shift));
  reveal(target);
}

const navCommand = (move: Move, key: string): Command => ({
  id: `nav.${move}`,
  title: `cmd.nav.${move}` as const,
  category: "cmd.cat.nav",
  keys: [key, `Shift+${key}`],
  views: ["grid"],
  run: (ctx) => navigate(move, ctx),
});

/** 选中 ≥ 2 张：批量（进行中不做事）；1 张：单张编辑（tab 为空时用上次的页签）。 */
function startEdit(tab: EditTab | undefined): void {
  const targets = opTargets();
  if (targets.length >= 2) {
    if (useBatch.getState().progress !== null) return;
    const { focus } = useSelection.getState();
    void enterBatch(targets, focus ?? targets[0], tab === "convert" ? "convert" : "compress");
    return;
  }
  if (targets.length !== 1) return;
  useNav.getState().openSingle(targets[0], "folder");
  void enterEdit(targets[0], tab);
}

const gridCommands: Command[] = [
  navCommand("left", "ArrowLeft"),
  navCommand("right", "ArrowRight"),
  navCommand("up", "ArrowUp"),
  navCommand("down", "ArrowDown"),
  navCommand("home", "Home"),
  navCommand("end", "End"),
  {
    id: "select.all",
    title: "cmd.select.all",
    category: "cmd.cat.select",
    keys: ["Mod+A"],
    views: ["grid"],
    run: () => {
      const sel = useSelection.getState();
      sel.set(selectAll(sel, useGridCtx.getState().list));
    },
  },
  {
    id: "select.clear",
    title: "cmd.select.clear",
    category: "cmd.cat.select",
    keys: ["Escape"],
    views: ["grid"],
    run: ({ repeat }) => {
      if (!repeat) useSelection.getState().clear();
    },
  },
  {
    id: "grid.open",
    title: "cmd.grid.open",
    category: "cmd.cat.view",
    keys: ["Enter"],
    views: ["grid"],
    run: () => {
      // 焦点为空、或所在分组已折叠（不在列表里）时不做事
      const { focus } = useSelection.getState();
      if (focus === null || !useGridCtx.getState().list.ids.includes(focus)) return;
      useNav.getState().openSingle(focus);
    },
  },
  {
    // E 键与右键菜单：多张等同批量压缩；一张先切到单张视图并定位这张图，再进入编辑
    id: "grid.edit",
    title: "cmd.grid.edit",
    category: "cmd.cat.edit",
    keys: ["E"],
    views: ["grid"],
    run: ({ repeat }) => {
      if (repeat) return;
      startEdit(undefined);
    },
  },
  {
    id: "grid.batchCompress",
    title: "cmd.grid.batchCompress",
    category: "cmd.cat.edit",
    keys: [],
    views: ["grid"],
    run: () => startEdit("compress"),
  },
  {
    id: "grid.batchConvert",
    title: "cmd.grid.batchConvert",
    category: "cmd.cat.edit",
    keys: [],
    views: ["grid"],
    run: () => startEdit("convert"),
  },
];

/** GridView 挂载期间注册；返回注销函数。 */
export function registerGridCommands(): () => void {
  return registerCommands(gridCommands);
}
