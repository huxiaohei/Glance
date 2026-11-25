import type { MessageKey } from "../i18n";
import { useCatalog } from "../stores/catalog";
import { topView } from "../stores/nav";
import { matchKey, type KeyLike } from "./keys";

export type ViewId = "start" | "grid" | "single" | "compare" | "edit";
/** repeat：按住不放的自动重复。绑在 Esc 上的命令应忽略它，免得一次长按连退几层。 */
export interface CommandCtx { shift: boolean; repeat: boolean }
export interface Command {
  id: string;
  title: MessageKey;
  category: MessageKey;
  keys: string[];                   // 第一个用于显示
  views: ViewId[] | "all";
  allowInInput?: boolean;           // 输入控件聚焦时是否仍可触发，默认否
  /** 返回 false 时这条命令当作不存在：不匹配、不拦默认行为 */
  when?(): boolean;
  run(ctx: CommandCtx): void;
}

const registry: Command[] = [];

/** 命令表的版本：每次注册、注销加一。界面上按命令表取键名的地方（快捷键提示）靠它在命令晚到时重算。 */
let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** 供 useSyncExternalStore 订阅命令表的变化。 */
export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function commandsVersion(): number {
  return version;
}

/** 注册命令，返回注销函数；id 重复时抛错（整批不生效）。 */
export function registerCommands(list: Command[]): () => void {
  const seen = new Set(registry.map((c) => c.id));
  for (const c of list) {
    if (seen.has(c.id)) throw new Error(`duplicate command id: ${c.id}`);
    seen.add(c.id);
  }
  registry.push(...list);
  bump();
  return () => {
    for (const c of list) {
      const i = registry.indexOf(c);
      if (i >= 0) registry.splice(i, 1);
    }
    bump();
  };
}

/** 按注册顺序。 */
export function allCommands(): Command[] {
  return [...registry];
}

/** 找出应执行的命令：适用于 view、按键匹配、when（若有）为真；inInput 为真时只考虑 allowInInput 的命令。 */
export function findCommand(e: KeyLike, view: ViewId, inInput: boolean, isMac: boolean): Command | null {
  for (const c of registry) {
    if (c.views !== "all" && !c.views.includes(view)) continue;
    if (inInput && !c.allowInInput) continue;
    if (!c.keys.some((k) => matchKey(e, k, isMac))) continue;
    if (c.when && !c.when()) continue;
    return c;
  }
  return null;
}

/** 当前视图：没有根目录为 "start"；否则按视图栈栈顶。 */
export function activeView(): ViewId {
  return useCatalog.getState().root ? topView().kind : "start";
}
