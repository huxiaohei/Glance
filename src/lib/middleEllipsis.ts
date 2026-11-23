/** 全角（CJK、全角符号、emoji 等）按 2 个单位，其余 1 个。 */
function charWidth(cp: number): number {
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2 : 1;
}
const w = (ch: string) => charWidth(ch.codePointAt(0)!);
const widthOf = (chars: string[]) => chars.reduce((n, c) => n + w(c), 0);

export const displayWidth = (s: string) => widthOf(Array.from(s));

/** 取 chars 开头不超过 budget 个单位的部分。 */
function takeHead(chars: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const c of chars) {
    if (used + w(c) > budget) break;
    out.push(c);
    used += w(c);
  }
  return out;
}
function takeTail(chars: string[], budget: number): string[] {
  return takeHead([...chars].reverse(), budget).reverse();
}

/**
 * 文件名过长时在中间用省略号截断，保留开头和扩展名。
 * max 以“窄字符单位”计：全角字符占 2，其余占 1；按码点处理，不拆代理对。
 */
export function middleEllipsis(name: string, max: number): string {
  const chars = Array.from(name);
  if (widthOf(chars) <= max) return name;
  if (max <= 1) return max === 1 ? "…" : "";
  const dot = chars.lastIndexOf(".");
  // 扩展名太长（留不出开头和省略号）时按无扩展名处理，保证总宽不超限
  const ext = dot > 0 && widthOf(chars.slice(dot)) <= max - 3 ? chars.slice(dot) : [];
  const stem = ext.length ? chars.slice(0, dot) : chars;
  const avail = max - 1 - widthOf(ext);
  // 有扩展名：尾部留一个词尾（至多 2 单位）；无扩展名：头尾对半
  const tail = takeTail(stem, ext.length ? Math.min(2, avail - 1) : avail >> 1);
  const head = takeHead(stem, avail - widthOf(tail));
  return head.join("") + "…" + tail.join("") + ext.join("");
}
