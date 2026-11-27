import { codecKindOf } from "./codecKind";

/**
 * 画面上的图是否比原图小（显示通道把长边超过上限的 HEIC / AVIF 缩小后再给出）。
 * 只对后端解码的格式判断：浏览器自己解码的格式不经显示通道，条目尺寸又按 EXIF 方向换算过，
 * 比较起来会误报。按长边比，免得宽高互换（方向、净孔径裁切）被当成缩小。
 * naturalW / naturalH 是显示出来的图的像素尺寸，还没有图时为 0；条目尺寸未知时不算缩小。
 */
export function isScaledDown(
  entry: { name: string; width?: number; height?: number },
  naturalW: number,
  naturalH: number,
): boolean {
  if (codecKindOf(entry.name) === null) return false;
  if (entry.width === undefined || entry.height === undefined) return false;
  const shown = Math.max(naturalW, naturalH);
  return shown > 0 && shown < Math.max(entry.width, entry.height);
}
