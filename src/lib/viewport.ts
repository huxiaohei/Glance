export interface Size {
  w: number;
  h: number;
}

/** scale 是图片像素到屏幕像素的倍率；(x, y) 是图片左上角相对容器左上角的位置（CSS 像素）。 */
export interface Viewport {
  scale: number;
  x: number;
  y: number;
  fit: boolean;
}

export const MAX_SCALE = 16;

/** 适应窗口的倍率：完整显示且不放大（小图按 100%）。任一边为 0 时返回 1。 */
export function fitScale(img: Size, box: Size): number {
  if (!(img.w > 0) || !(img.h > 0) || !(box.w > 0) || !(box.h > 0)) return 1;
  return Math.min(1, box.w / img.w, box.h / img.h);
}

export function minScale(img: Size, box: Size): number {
  return Math.min(fitScale(img, box), 0.1);
}

/** 在一个方向上算合法位置：不大于容器则居中，否则不露空边。 */
function clampAxis(pos: number, content: number, container: number): number {
  if (content <= container) return (container - content) / 2;
  return Math.min(0, Math.max(container - content, pos));
}

/** 适应窗口并居中。 */
export function fitViewport(img: Size, box: Size): Viewport {
  const scale = fitScale(img, box);
  return {
    scale,
    x: (box.w - img.w * scale) / 2,
    y: (box.h - img.h * scale) / 2,
    fit: true,
  };
}

/** 把位置夹到合法范围：某一方向上图片不大于容器时在该方向居中，否则不允许露出空边。 */
export function clampViewport(v: Viewport, img: Size, box: Size): Viewport {
  return {
    ...v,
    x: clampAxis(v.x, img.w * v.scale, box.w),
    y: clampAxis(v.y, img.h * v.scale, box.h),
  };
}

/** 把倍率设为 target（先夹到合法范围），保持 (px, py) 下的图片点不动，再 clamp。 */
function scaleAt(v: Viewport, target: number, px: number, py: number, img: Size, box: Size): Viewport {
  const lo = minScale(img, box);
  const scale = Math.min(MAX_SCALE, Math.max(lo, target));
  const old = v.scale > 0 && Number.isFinite(v.scale) ? v.scale : 1;
  const ix = (px - v.x) / old;
  const iy = (py - v.y) / old;
  const moved = clampViewport({ scale, x: px - ix * scale, y: py - iy * scale, fit: false }, img, box);
  const fs = fitScale(img, box);
  const fit = Math.abs(scale - fs) < 1e-9 && img.w * scale <= box.w && img.h * scale <= box.h;
  return { ...moved, fit };
}

/** 以容器内的点 (px, py) 为中心把倍率乘以 factor，夹到 [minScale, MAX_SCALE]，再 clamp。 */
export function zoomAt(
  v: Viewport,
  factor: number,
  px: number,
  py: number,
  img: Size,
  box: Size,
): Viewport {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return scaleAt(v, v.scale * f, px, py, img, box);
}

export function panBy(v: Viewport, dx: number, dy: number, img: Size, box: Size): Viewport {
  return clampViewport({ ...v, x: v.x + dx, y: v.y + dy, fit: false }, img, box);
}

/** 以 (px, py) 为中心设为 100%。 */
export function actualSize(v: Viewport, px: number, py: number, img: Size, box: Size): Viewport {
  return scaleAt(v, 1, px, py, img, box);
}

/** 双击：当前是适应窗口 → 以该点为中心 100%（适应倍率本来就是 1 时不变）；否则 → 适应窗口。 */
export function toggleFit(v: Viewport, px: number, py: number, img: Size, box: Size): Viewport {
  if (!v.fit) return fitViewport(img, box);
  if (fitScale(img, box) === 1) return v;
  return actualSize(v, px, py, img, box);
}

/** 容器尺寸变化：v.fit 为真 → 重新适应；否则保持倍率，按新容器 clamp。 */
export function resizeViewport(v: Viewport, img: Size, box: Size): Viewport {
  return v.fit ? fitViewport(img, box) : clampViewport(v, img, box);
}

/** 滚轮增量 → 倍率因子：exp(-deltaY × 0.0015)，按住 Ctrl（触控板捏合）时系数为 0.01。 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.0015));
}
