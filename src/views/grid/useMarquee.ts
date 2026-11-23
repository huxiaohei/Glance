import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../app/keys";
import { GRID_PAD, idsInRect, type GridLayout, type Rect } from "../../lib/gridLayout";
import { edgeScroll } from "../../lib/marquee";
import { selectMany, type Selection } from "../../lib/selection";
import { useSelection } from "../../stores/selection";

const THRESHOLD = 4; // 移动超过这个距离（px）才算拖动

interface Press {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  start: { x: number; y: number }; // 内容区坐标
  base: Selection; // 按下时的选中
  additive: boolean;
  active: boolean; // 已超过阈值、正在框选
  lastX: number;
  lastY: number;
  rect: Rect | null; // 上一帧算出的矩形
}

/** 滚动区视口坐标 → 内容区坐标。 */
function toContent(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: clientX - r.left - el.clientLeft - GRID_PAD + el.scrollLeft,
    y: clientY - r.top - el.clientTop + el.scrollTop,
  };
}

/** 在滚动区空白处按下并拖动超过 4 px 后开始框选；返回要画的矩形（内容区坐标）或 null。
 *  拖动中实时 selectMany(起始时的选中, idsInRect(...), 按下时是否按着 Mod 或 Shift)；
 *  起点记在内容区坐标里，所以拖动时滚动（滚轮或边缘自动滚动）会自然扩大范围。
 *  松开或按 Esc 结束；没有超过 4 px 的按下视为空白处单击（清空选中，由任务 9 的逻辑处理）。 */
export function useMarquee(scroller: HTMLElement | null, layout: GridLayout, cell: number): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  const geometry = useRef({ layout, cell });
  geometry.current = { layout, cell };

  useEffect(() => {
    if (!scroller) return;
    const el = scroller;
    let press: Press | null = null;
    let frame: number | null = null;

    // 每帧至多一次：边缘自动滚动，再按最后的指针位置与新的 scrollTop 求矩形并更新选中
    const tick = () => {
      frame = null;
      if (!press?.active) return;
      const view = el.getBoundingClientRect();
      const dy = edgeScroll(press.lastY, view.top, view.bottom);
      const before = el.scrollTop;
      if (dy !== 0) el.scrollTop += dy;
      const scrolled = el.scrollTop !== before; // 滚到头后不再空转
      const { layout: lay, cell: c } = geometry.current;
      const end = toContent(el, press.lastX, press.lastY);
      // 只画在画布范围内，免得框本身撑出滚动条
      const maxY = Math.max(lay.totalHeight, el.clientHeight);
      const clampX = (x: number) => Math.min(Math.max(x, -GRID_PAD), el.clientWidth - GRID_PAD);
      const clampY = (y: number) => Math.min(Math.max(y, 0), maxY);
      const r: Rect = { x0: clampX(press.start.x), y0: clampY(press.start.y), x1: clampX(end.x), y1: clampY(end.y) };
      const prev = press.rect;
      if (!prev || prev.x0 !== r.x0 || prev.y0 !== r.y0 || prev.x1 !== r.x1 || prev.y1 !== r.y1) {
        press.rect = r;
        setRect(r);
        useSelection.getState().set(selectMany(press.base, idsInRect(lay, c, r), press.additive));
      }
      if (scrolled) schedule();
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(tick);
    };

    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (press) {
        try { el.releasePointerCapture(press.pointerId); } catch { /* 已释放 */ }
        if (press.active) setRect(null);
      }
      press = null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return; // macOS 上 Ctrl + 单击等同右键
      if ((e.target as Element).closest(".thumb-cell, .group-header")) return;
      // 竖向滚动条在内容区右侧，按下点落在 clientWidth 之外
      if (e.clientX - el.getBoundingClientRect().left >= el.clientLeft + el.clientWidth) return;
      finish();
      const additive = (IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey;
      const { ids, focus, anchor } = useSelection.getState();
      press = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        start: toContent(el, e.clientX, e.clientY),
        base: { ids, focus, anchor },
        additive,
        active: false,
        lastX: e.clientX,
        lastY: e.clientY,
        rect: null,
      };
      // 捕获指针：拖出滚动区（含窗口外）时仍收得到移动与松开
      try { el.setPointerCapture(e.pointerId); } catch { /* 指针已不在 */ }
      if (!additive) useSelection.getState().clear(); // 空白处单击清空；拖动时由框选结果覆盖
    };

    const onMove = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      press.lastX = e.clientX;
      press.lastY = e.clientY;
      if (!press.active) {
        if (Math.hypot(e.clientX - press.startClientX, e.clientY - press.startClientY) <= THRESHOLD) return;
        press.active = true;
      }
      schedule();
    };

    const onUp = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      // 松开前还有没处理的移动：先按最后位置算一次，选中不落后一帧
      if (press.active && frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
        tick();
      }
      finish();
    };

    // 拖动中滚轮滚动：起点固定在内容区，终点随 scrollTop 变化
    const onScroll = () => {
      if (press?.active) schedule();
    };

    // 捕获阶段拦下拖动中的 Esc，免得同一次按键再触发网格的清空选中命令
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !press?.active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useSelection.getState().set(press.base);
      finish();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey, true);
    return () => {
      finish();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [scroller]);

  return rect;
}
