import { registerCommands, type Command } from "../../app/commands";
import { useNav } from "../../stores/nav";

const singleCommands: Command[] = [
  {
    id: "single.back",
    title: "cmd.single.back",
    category: "cmd.cat.view",
    keys: ["Escape"],
    views: ["single"],
    run: () => useNav.getState().back(),
  },
];

/** SingleView 挂载期间注册；返回注销函数。 */
export function registerSingleCommands(): () => void {
  return registerCommands(singleCommands);
}
