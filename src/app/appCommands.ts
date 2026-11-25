import { useListView } from "../stores/listView";
import { useSettings } from "../stores/settings";
import { useTip } from "../stores/tip";
import { pickAndOpenFolder, refreshFolder } from "./openFolder";
import { activeView, registerCommands, type Command } from "./commands";
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
    // 编辑中不换目录（换目录会丢掉编辑）：先保存或取消
    when: () => activeView() !== "edit",
    run: () => void pickAndOpenFolder(),
  },
  {
    id: "view.refresh",
    title: "cmd.view.refresh",
    category: "cmd.cat.view",
    keys: ["F5", "Mod+R"],
    // 单张视图与编辑中也要拦下：否则按键落到 WebView，WebView2 会重新载入页面、丢掉全部状态
    views: ["grid", "single", "edit"],
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
    id: "app.settings",
    title: "cmd.app.settings",
    category: "cmd.cat.general",
    keys: ["Mod+,"],
    views: "all",
    allowInInput: true,
    run: () => useSettings.setState((s) => ({ open: !s.open })),
  },
  {
    id: "app.tip",
    title: "cmd.app.tip",
    category: "cmd.cat.general",
    keys: [],
    views: "all",
    run: () => useTip.setState((s) => ({ open: !s.open })),
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
