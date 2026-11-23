const NOTCH = 100; // 一格鼠标滚轮的 deltaY（像素模式）

/**
 * 累积 Cmd/Ctrl + 滚轮的增量。每凑满一个 NOTCH 给出一步：向上滚（deltaY < 0）为正步数（放大）。
 * deltaMode 为 1（按行）时增量乘 100。返回新的余量和本次要走的步数。
 */
export function accumulateWheel(acc: number, deltaY: number, deltaMode: number): { acc: number; steps: number } {
  const total = acc + (deltaMode === 1 ? deltaY * NOTCH : deltaY);
  const whole = Math.trunc(total / NOTCH);
  return { acc: total - whole * NOTCH, steps: 0 - whole };
}
