import { registerCommands, type Command } from "./commands";
import { copyImage, copyPaths, pickAndTransfer, revealFirst, transferToNewChild, trashTargets, undoLast } from "./fileOps";
import { startRename } from "../stores/rename";
import { IS_MAC } from "./keys";

/** 页面上没有选中的文字：有的话 Mod+C 留给系统复制文字（例如详情面板里的文字）。 */
function noTextSelected(): boolean {
  return (window.getSelection()?.toString() ?? "") === "";
}

/** 文件操作的命令。删除键按平台习惯：macOS 用 ⌘⌫（⌘⌦ 同样可用），其他平台用 Delete。 */
export function fileCommands(isMac: boolean): Command[] {
  return [
    {
      id: "file.trash",
      title: "cmd.file.trash",
      category: "cmd.cat.file",
      keys: isMac ? ["Mod+Backspace", "Mod+Delete"] : ["Delete"],
      views: ["grid", "single"],
      run: (ctx) => {
        if (!ctx.repeat) void trashTargets();
      },
    },
    {
      id: "file.rename",
      title: "cmd.file.rename",
      category: "cmd.cat.file",
      keys: ["F2"],
      views: ["grid", "single"],
      run: () => startRename(),
    },
    {
      id: "file.moveTo",
      title: "cmd.file.moveTo",
      category: "cmd.cat.file",
      keys: [],
      views: ["grid", "single"],
      run: (ctx) => {
        if (!ctx.repeat) void pickAndTransfer("move");
      },
    },
    {
      id: "file.copyTo",
      title: "cmd.file.copyTo",
      category: "cmd.cat.file",
      keys: [],
      views: ["grid", "single"],
      run: (ctx) => {
        if (!ctx.repeat) void pickAndTransfer("copy");
      },
    },
    {
      id: "file.moveToNew",
      title: "cmd.file.moveToNew",
      category: "cmd.cat.file",
      keys: [],
      views: ["grid", "single"],
      run: (ctx) => {
        if (!ctx.repeat) void transferToNewChild("move");
      },
    },
    {
      id: "file.copyImage",
      title: "cmd.file.copyImage",
      category: "cmd.cat.file",
      keys: ["Mod+C"],
      views: ["grid", "single"],
      when: noTextSelected,
      run: (ctx) => {
        if (!ctx.repeat) void copyImage();
      },
    },
    {
      id: "file.copyPath",
      title: "cmd.file.copyPath",
      category: "cmd.cat.file",
      keys: ["Mod+Shift+C"],
      views: ["grid", "single"],
      when: noTextSelected,
      run: (ctx) => {
        if (!ctx.repeat) void copyPaths();
      },
    },
    {
      id: "file.reveal",
      title: isMac ? "cmd.file.revealMac" : "cmd.file.revealWin",
      category: "cmd.cat.file",
      keys: [],
      views: ["grid", "single"],
      run: (ctx) => {
        if (!ctx.repeat) void revealFirst();
      },
    },
    {
      id: "file.undo",
      title: "cmd.file.undo",
      category: "cmd.cat.file",
      keys: ["Mod+Z"],
      // 不标 allowInInput：输入框里的 Mod+Z 留给文字撤销
      views: "all",
      run: (ctx) => {
        if (!ctx.repeat) void undoLast();
      },
    },
  ];
}

/** 应用启动时注册一次；返回注销函数。 */
export function registerFileCommands(isMac: boolean = IS_MAC): () => void {
  return registerCommands(fileCommands(isMac));
}
