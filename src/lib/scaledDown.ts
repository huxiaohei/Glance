/**
 * 画面上的图是否比原图小（显示通道把长边超过上限的 HEIC / AVIF 缩小后再给出）。
 * natural 是显示出来的图的像素宽度，还没有图时为 0；entryW 是条目记下的原图宽度，未知时不算缩小。
 */
export function isScaledDown(natural: number, entryW: number | undefined): boolean {
  return entryW !== undefined && natural > 0 && natural < entryW;
}
