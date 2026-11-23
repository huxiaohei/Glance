/** 原生菜单把单个 & 当作助记符标记：标签里的每个 & 写成 &&，原样显示。 */
export function escapeMnemonic(label: string): string {
  return label.replace(/&/g, "&&");
}
