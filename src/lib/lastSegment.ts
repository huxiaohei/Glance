/** 路径的最后一级名字，`/` 与 `\` 都认，忽略结尾的分隔符；没有可取的一级（如 "/"）时原样返回。 */
export function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter((s) => s !== "");
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
