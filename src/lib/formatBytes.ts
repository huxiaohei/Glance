const UNITS = ["B", "KB", "MB", "GB"];

/** 1023 → "1023 B"；1536 → "1.5 KB"；5_242_880 → "5.0 MB"；1 位小数，1024 进制，最大单位 GB。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.floor(n || 0))} B`;
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${UNITS[u]}`;
}
