import { en } from "./en";
import { zhCN } from "./zh-CN";

export type MessageKey = keyof typeof zhCN;
export type MessageVars = Record<string, string | number>;

export function translate(locale: string, key: MessageKey, vars?: MessageVars): string {
  const text = locale.toLowerCase().startsWith("zh") ? zhCN[key] : en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(navigator.language, key, vars);
}
