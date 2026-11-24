export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

/** 指针是否已越过窗口内容区边界向外 margin 像素以内（即将离开）。 */
export function isLeavingWindow(p: Point, viewport: Size, margin = 4): boolean {
  return (
    p.x <= margin ||
    p.y <= margin ||
    p.x >= viewport.width - margin ||
    p.y >= viewport.height - margin
  );
}

/** 指针是否已在窗口内容区之外（贴着边缘但仍在视口内不算）。 */
export function isOutsideWindow(p: Point, viewport: Size): boolean {
  return p.x < 0 || p.y < 0 || p.x >= viewport.width || p.y >= viewport.height;
}
