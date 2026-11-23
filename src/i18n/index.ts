import type { Language } from "../ipc/types";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type MessageKey = keyof typeof zhCN;
export type MessageVars = Record<string, string | number>;

export function translate(locale: string, key: MessageKey, vars?: MessageVars): string {
  const text = locale.toLowerCase().startsWith("zh") ? zhCN[key] : en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

let current: Language = "system";

/** 切换界面语言；"system" 时跟随 navigator.language。 */
export function setLanguage(lang: Language): void {
  current = lang;
}

/** 当前生效的语言标签（给 Intl 用）。 */
export function locale(): string {
  return current === "system" ? navigator.language : current;
}

export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(locale(), key, vars);
}
