import { registerCommands, type Command, type CommandCtx } from "../../app/commands";
import { moveInLayout, type Move } from "../../lib/gridLayout";
import { moveTo, selectAll } from "../../lib/selection";
import { useGridCtx } from "../../stores/gridCtx";
import { useSelection } from "../../stores/selection";

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
    run: () => useSelection.getState().clear(),
  },
];

/** GridView 挂载期间注册；返回注销函数。 */
export function registerGridCommands(): () => void {
  return registerCommands(gridCommands);
}
