import type { FileId } from "../../ipc/types";
import { previewOrder, slotAt, type SortGrid } from "../../lib/dragSort";
import { edgeScroll } from "../../lib/marquee";
import { useBasket } from "../../stores/basket";
import { useCompareUi } from "../../stores/compareUi";

/** 进行中的排序拖动。由 useCompareViewport 在按下没放大的格子、移动够远后开始。 */
export interface SortDrag {
  /** 指针移动到 (x, y)（视口坐标）：下一帧重算。 */
  move(x: number, y: number): void;
  /** 结束：commit 为真时按最后的目标下标改对比篮顺序并把焦点设到被拖的格，否则格子回原位。已结束时不做事。 */
  finish(commit: boolean): void;
}

const translate = (x: number, y: number) => (x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px)`);

/**
 * 开始拖动 id 那一格（起点为按下时的视口坐标）。格子尺寸、列数与间隙在开始时从 DOM 量出（面板开合后格子变小也按实量）。
 * 热路径：每帧只直接写各格的 style.transform——被拖的格跟随指针，其余格平移到预览顺序里的新槽位；
 * 不改 React 状态、不改 DOM 顺序。指针贴近滚动区上下边缘时自动滚动，滚动后重算目标。
 * 拖动期间在 window 捕获阶段挂 keydown：Esc 取消并拦下（免得同一次按键再触发“返回”命令），与网格拖拽相同的例外。
 * 格子不足两张或找不到该格时返回 null。
 */
export function beginSortDrag(scroller: HTMLElement, id: FileId, startX: number, startY: number): SortDrag | null {
  const cells = [...scroller.querySelectorAll<HTMLElement>(".compare-cell")];
  const ids = cells.map((c) => Number(c.dataset.id));
  const from = ids.indexOf(id);
  if (cells.length < 2 || from < 0) return null;
  const dragged = cells[from];

  // 量网格：第一格的位置与尺寸，第一行的格数即列数，相邻格之差即间隙。纵向用内容区坐标（加上 scrollTop）
  const rects = cells.map((c) => c.getBoundingClientRect());
  const r0 = rects[0];
  let columns = 1;
  while (columns < rects.length && Math.abs(rects[columns].top - r0.top) < 1) columns++;
  const scrollTop0 = scroller.scrollTop;
  const grid: SortGrid = {
    left: r0.left,
    top: r0.top + scrollTop0,
    cellW: r0.width,
    cellH: r0.height,
    gapX: columns > 1 ? Math.max(0, rects[1].left - r0.right) : 0,
    gapY: rects.length > columns ? Math.max(0, rects[columns].top - r0.bottom) : 0,
    columns,
  };
  const pitchX = grid.cellW + grid.gapX;
  const pitchY = grid.cellH + grid.gapY;

  let lastX = startX;
  let lastY = startY;
  let to = from;
  let laidOut = -1; // 其余格上一次按哪个目标摆的
  let carry = 0; // 自动滚动累积的不足 1 px 的部分
  let frame: number | null = null;
  let done = false;

  // 其余格按预览顺序平移：原在 j 的格挪到 k，按行列差换算位移
  const layoutOthers = () => {
    if (laidOut === to) return;
    laidOut = to;
    const preview = previewOrder(ids, from, to);
    preview.forEach((cid, k) => {
      if (cid === id) return;
      const j = ids.indexOf(cid);
      const dx = ((k % columns) - (j % columns)) * pitchX;
      const dy = (Math.floor(k / columns) - Math.floor(j / columns)) * pitchY;
      cells[j].style.transform = translate(dx, dy);
    });
  };

  const tick = () => {
    frame = null;
    if (done) return;
    const view = scroller.getBoundingClientRect();
    const speed = edgeScroll(lastY, view.top, view.bottom);
    // 只按整像素滚动，余下的小数留到下一帧
    carry = speed === 0 ? 0 : carry + speed;
    const step = Math.trunc(carry);
    if (step !== 0) {
      scroller.scrollTop += step;
      carry -= step;
    }
    const max = scroller.scrollHeight - scroller.clientHeight;
    const atLimit = speed > 0 ? scroller.scrollTop >= max - 1 : scroller.scrollTop <= 0;
    const scrolled = scroller.scrollTop - scrollTop0;
    dragged.style.transform = `translate(${lastX - startX}px, ${lastY - startY + scrolled}px)`;
    to = slotAt({ x: lastX, y: lastY + scroller.scrollTop }, grid, cells.length);
    layoutOthers();
    if (speed !== 0 && !atLimit) schedule(); // 滚到头后不再空转
  };
  const schedule = () => {
    if (frame === null && !done) frame = requestAnimationFrame(tick);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(false);
  };
  // 拖动中滚轮滚动：按新的 scrollTop 重算
  const onScroll = () => schedule();

  const finish = (commit: boolean) => {
    if (done) return;
    // 松开前还有没处理的移动：先按最后位置算一次，目标不落后一帧
    if (commit && frame !== null) {
      cancelAnimationFrame(frame);
      tick();
    }
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    window.removeEventListener("keydown", onKey, true);
    scroller.removeEventListener("scroll", onScroll);
    // 先摘掉让位过渡再清 transform，免得格子从预览位置滑回去
    scroller.classList.remove("is-sorting");
    dragged.classList.remove("is-dragging");
    for (const c of cells) c.style.transform = "";
    if (!commit) return;
    useBasket.getState().move(id, to);
    useCompareUi.getState().setFocus(id);
  };

  scroller.classList.add("is-sorting");
  dragged.classList.add("is-dragging");
  window.addEventListener("keydown", onKey, true);
  scroller.addEventListener("scroll", onScroll, { passive: true });

  return {
    move(x, y) {
      if (done) return;
      lastX = x;
      lastY = y;
      schedule();
    },
    finish,
  };
}
