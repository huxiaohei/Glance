import { registerCommands, type Command } from "../../app/commands";
import { useNav } from "../../stores/nav";

/** 对比视图的命令。任务 8 在这里补上焦点移动、打开、移出、缩放与同步开关。 */
const compareCommands: Command[] = [
  {
    id: "compare.back",
    title: "cmd.compare.back",
    category: "cmd.cat.compare",
    keys: ["Escape"],
    views: ["compare"],
    // 长按 Esc 的自动重复不连退几层
    run: ({ repeat }) => {
      if (!repeat) useNav.getState().back();
    },
  },
];

/** 应用启动时注册一次；返回注销函数。 */
export function registerCompareCommands(): () => void {
  return registerCommands(compareCommands);
}
