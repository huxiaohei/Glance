const EDGE = 24; // 自动滚动的边缘带宽度（px）
const MAX_SPEED = 16; // 边缘处的速度（px/帧）

/** 指针离滚动区上下边缘不足 24 px 时的自动滚动速度（像素/帧）：边缘处 ±16，线性衰减到 0；其余为 0。 */
export function edgeScroll(pointerY: number, viewTop: number, viewBottom: number): number {
  const fromTop = pointerY - viewTop;
  if (fromTop < EDGE) return -MAX_SPEED * Math.min(1, (EDGE - fromTop) / EDGE);
  const fromBottom = viewBottom - pointerY;
  if (fromBottom < EDGE) return MAX_SPEED * Math.min(1, (EDGE - fromBottom) / EDGE);
  return 0;
}
