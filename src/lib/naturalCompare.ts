const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 自然排序：数字段按数值比较，不分大小写；相等时回落到普通字符串比较以保证稳定。 */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
