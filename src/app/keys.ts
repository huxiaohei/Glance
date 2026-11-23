export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as { platform?: string; userAgent?: string };
  return /mac|iphone|ipad/i.test(nav.platform ?? nav.userAgent ?? "");
}

export const IS_MAC: boolean = detectMac();

function parse(combo: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = combo.split("+");
  // 末尾为空说明按键本身是 "+"（如 "Mod++"）
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return { mod: mods.has("Mod"), shift: mods.has("Shift"), alt: mods.has("Alt"), key };
}

/** 组合键写法："Mod+A"、"Shift+ArrowLeft"、"F5"、"?"、"Tab"。Mod 在 macOS 上是 Cmd，其他平台是 Ctrl。
 *  字母不分大小写。单个非字母数字的可打印字符（如 "?"）不比较 Shift。其余修饰键必须完全一致。 */
export function matchKey(e: KeyLike, combo: string, isMac: boolean): boolean {
  const c = parse(combo);
  const modDown = isMac ? e.metaKey : e.ctrlKey;
  const otherDown = isMac ? e.ctrlKey : e.metaKey;
  if (c.mod !== modDown || otherDown) return false;
  if (c.alt !== e.altKey) return false;
  const printableSymbol = c.key.length === 1 && !/[a-z0-9]/i.test(c.key);
  if (!printableSymbol && c.shift !== e.shiftKey) return false;
  return c.key.length === 1 ? e.key.toLowerCase() === c.key.toLowerCase() : e.key === c.key;
}

const ARROWS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** 显示用：macOS "⌘A" "⇧←" "F5"；其他平台 "Ctrl+A" "Shift+←"。 */
export function formatKey(combo: string, isMac: boolean): string {
  const c = parse(combo);
  const key = ARROWS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (isMac) return `${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}${key}`;
  return [c.mod ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", key].filter(Boolean).join("+");
}
