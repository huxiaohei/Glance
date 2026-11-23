import { useListView } from "../stores/listView";
import { pickAndOpenFolder, refreshFolder } from "./openFolder";
import { registerCommands, type Command } from "./commands";
import { toggleFullscreen } from "./fullscreen";
import { useHelp } from "./useKeyboard";

const appCommands: Command[] = [
  {
    id: "app.open",
    title: "cmd.app.open",
    category: "cmd.cat.general",
    keys: ["Mod+O"],
    views: "all",
    allowInInput: true,
    run: () => void pickAndOpenFolder(),
  },
  {
    id: "view.refresh",
    title: "cmd.view.refresh",
    category: "cmd.cat.view",
    keys: ["F5", "Mod+R"],
    views: ["grid"],
    allowInInput: true,
    run: () => void refreshFolder(),
  },
  {
    id: "view.toggleSidebar",
    title: "cmd.view.toggleSidebar",
    category: "cmd.cat.view",
    keys: ["Tab"],
    views: ["grid"],
    run: () => useListView.getState().toggleTree(),
  },
  {
    id: "view.fullscreen",
    title: "cmd.view.fullscreen",
    category: "cmd.cat.view",
    keys: ["F"],
    views: "all",
    run: (ctx) => {
      if (!ctx.repeat) void toggleFullscreen();
    },
  },
  {
    id: "help.shortcuts",
    title: "cmd.help.shortcuts",
    category: "cmd.cat.general",
    keys: ["?"],
    views: "all",
    run: () => useHelp.setState((s) => ({ open: !s.open })),
  },
];

/** 应用启动时注册一次；返回注销函数（StrictMode 下的二次执行靠它收拾干净）。 */
export function registerAppCommands(): () => void {
  return registerCommands(appCommands);
}
