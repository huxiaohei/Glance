import { en } from "./en";
import { zhCN } from "./zh-CN";

export type MessageKey = keyof typeof zhCN;

export function translate(locale: string, key: MessageKey): string {
  return locale.toLowerCase().startsWith("zh") ? zhCN[key] : en[key];
}

export function t(key: MessageKey): string {
  return translate(navigator.language, key);
}
