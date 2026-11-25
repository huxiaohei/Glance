import type { FileId } from "../ipc/types";
import { useBasket } from "../stores/basket";
import { topView, useNav } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { registerCommands, type Command } from "./commands";
import { getImageList } from "./useImageList";

/** 空格的作用对象：单张视图是当前图；网格是选中的图（按网格显示顺序），没有选中时是焦点所在的图。 */
function targets(): FileId[] {
  const top = topView();
  if (top.kind === "single") return [top.id];
  const { ids, focus } = useSelection.getState();
  if (ids.size > 0) return getImageList().ids.filter((id) => ids.has(id));
  return focus === null ? [] : [focus];
}

const basketCommands: Command[] = [
  {
    id: "basket.toggle",
    title: "cmd.basket.toggle",
    category: "cmd.cat.compare",
    keys: [" "],
    views: ["grid", "single"],
    // 按住空格不放不连续翻转
    run: (ctx) => {
      if (ctx.repeat) return;
      const ids = targets();
      if (ids.length > 0) useBasket.getState().toggle(ids);
    },
  },
  {
    id: "basket.open",
    title: "cmd.basket.open",
    category: "cmd.cat.compare",
    keys: ["C"],
    views: ["grid", "single"],
    when: () => useBasket.getState().order.length > 0,
    run: (ctx) => {
      if (!ctx.repeat) useNav.getState().openCompare();
    },
  },
];

/** 应用启动时注册一次；返回注销函数。 */
export function registerBasketCommands(): () => void {
  return registerCommands(basketCommands);
}
