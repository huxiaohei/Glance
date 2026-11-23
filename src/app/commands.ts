import type { MessageKey } from "../i18n";
import { useCatalog } from "../stores/catalog";
import { topView } from "../stores/nav";
import { matchKey, type KeyLike } from "./keys";

export type ViewId = "start" | "grid" | "single" | "compare" | "edit";
export interface CommandCtx { shift: boolean }
export interface Command {
  id: string;
  title: MessageKey;
  category: MessageKey;
  keys: string[];                   // 第一个用于显示
  views: ViewId[] | "all";
  allowInInput?: boolean;           // 输入控件聚焦时是否仍可触发，默认否
  run(ctx: CommandCtx): void;
}

const registry: Command[] = [];

/** 注册命令，返回注销函数；id 重复时抛错（整批不生效）。 */
export function registerCommands(list: Command[]): () => void {
  const seen = new Set(registry.map((c) => c.id));
  for (const c of list) {
    if (seen.has(c.id)) throw new Error(`duplicate command id: ${c.id}`);
    seen.add(c.id);
  }
  registry.push(...list);
  return () => {
    for (const c of list) {
      const i = registry.indexOf(c);
      if (i >= 0) registry.splice(i, 1);
    }
  };
}

/** 按注册顺序。 */
export function allCommands(): Command[] {
  return [...registry];
}

/** 找出应执行的命令：适用于 view、按键匹配；inInput 为真时只考虑 allowInInput 的命令。 */
export function findCommand(e: KeyLike, view: ViewId, inInput: boolean, isMac: boolean): Command | null {
  for (const c of registry) {
    if (c.views !== "all" && !c.views.includes(view)) continue;
    if (inInput && !c.allowInInput) continue;
    if (c.keys.some((k) => matchKey(e, k, isMac))) return c;
  }
  return null;
}

/** 当前视图：没有根目录为 "start"；否则按视图栈栈顶。 */
export function activeView(): ViewId {
  return useCatalog.getState().root ? topView().kind : "start";
}
