import { t } from "../../i18n";
import { useDrag } from "../../stores/drag";

const OFFSET = 12; // 徽标相对指针的偏移（px）

// 徽标位置不走 React 状态：每次指针移动直接写 style.transform
let badgeEl: HTMLDivElement | null = null;
let lastPos: { x: number; y: number } | null = null;

const place = (el: HTMLElement, x: number, y: number) => {
  el.style.transform = `translate(${x + OFFSET}px, ${y + OFFSET}px)`;
};

/** 把徽标移到指针 (x, y) 右下方 (12, 12) 处。徽标未挂载时只记下位置，挂载时补上。 */
export function moveBadge(x: number, y: number): void {
  lastPos = { x, y };
  if (badgeEl) place(badgeEl, x, y);
}

const attach = (el: HTMLDivElement | null) => {
  badgeEl = el;
  if (el && lastPos) place(el, lastPos.x, lastPos.y);
};

/** 拖拽中跟着指针的张数徽标。 */
export default function DragBadge() {
  const count = useDrag((s) => s.count);
  const copy = useDrag((s) => s.copy);
  if (count === 0) return null;
  return (
    <div className="drag-badge" ref={attach}>
      {t(copy ? "drag.countCopy" : "drag.count", { n: count })}
    </div>
  );
}
