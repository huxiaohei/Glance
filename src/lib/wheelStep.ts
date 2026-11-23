/**
 * 滚轮切图的步进器：累计纵向滚动量，达到阈值且距上次切换不少于间隔时返回方向（向下为 1）。
 * 方向改变时累计先清零；间隔内到达的事件直接丢弃（累计保持为 0），用来吞掉触控板的惯性滚动。
 */
export function createWheelStepper(
  opts: { threshold?: number; cooldownMs?: number } = {},
): (dy: number, now: number) => -1 | 0 | 1 {
  const threshold = opts.threshold ?? 60;
  const cooldownMs = opts.cooldownMs ?? 150;
  let acc = 0;
  let last = -Infinity;
  return (dy, now) => {
    if (now - last < cooldownMs) {
      acc = 0;
      return 0;
    }
    if (acc !== 0 && Math.sign(acc) !== Math.sign(dy)) acc = 0;
    acc += dy;
    if (Math.abs(acc) < threshold) return 0;
    const dir = acc > 0 ? 1 : -1;
    acc = 0;
    last = now;
    return dir;
  };
}
