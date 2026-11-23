/** 文件名过长时在中间用省略号截断，保留开头和扩展名（按 UTF-16 单元计长，max 为总长上限）。 */
export function middleEllipsis(name: string, max: number): string {
  if (name.length <= max) return name;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  const dot = name.lastIndexOf(".");
  // 扩展名（含点）太长时按无扩展名处理，保证前半段不被挤没
  const hasExt = dot > 0 && name.length - dot <= Math.floor(max / 2);
  if (!hasExt) {
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    return name.slice(0, head) + "…" + name.slice(name.length - (keep - head));
  }
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  // 尾部多留 2 个字符（扩展名前的词尾），其余给开头
  const tail = Math.min(2, Math.max(0, max - 1 - ext.length - 1));
  const head = max - 1 - ext.length - tail;
  return stem.slice(0, head) + "…" + stem.slice(stem.length - tail) + ext;
}
