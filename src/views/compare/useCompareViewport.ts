import { useEffect, useLayoutEffect, useRef } from "react";
import { showImageMenu } from "../../app/contextMenu";
import type { FileId } from "../../ipc/types";
import {
  cellTransform,
  isZoomed,
  panInCell,
  zoomAtCell,
  type CompareViewport,
} from "../../lib/compareViewport";
import { wheelFactor, type Size } from "../../lib/viewport";
import { useCompareUi } from "../../stores/compareUi";
import { useNav } from "../../stores/nav";
import { beginSortDrag, type SortDrag } from "./compareDragSort";

/** 对比视图当前的布局：图片区尺寸（所有格相同）、已知尺寸且未缺失的格的图片尺寸、缺失集合。 */
export interface CompareLayout {
  box: Size;
  sizes: ReadonlyMap<FileId, Size>;
  missing: ReadonlySet<FileId>;
}

/** 滚轮停下这么久后把视口写回 store。 */
export const WHEEL_COMMIT_MS = 150;
/** 按下后移动不到这么多像素仍算单击 / 双击。 */
const CLICK_SLOP = 4;
const LINE_PX = 16;

/** 图片元素的 transform：宽高为图片像素、transform-origin 0 0。渲染与 rAF 共用同一写法。 */
export function picTransform(vp: CompareViewport, img: Size, box: Size): string {
  const v = cellTransform(vp, img, box);
  return `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
}

/** 参与“最先触顶 / 最后放进格子”判断的格子：同步开时为全部已知尺寸的格。 */
export function layoutCells(layout: CompareLayout): { img: Size; box: Size }[] {
  return [...layout.sizes.values()].map((img) => ({ img, box: layout.box }));
}

// 挂载中的对比视图：命令（键盘缩放）要用它的布局，并在改 store 之前把热路径上未写回的视口写回
let active: { layout: () => CompareLayout; flush: () => void } | null = null;

/** 挂载中的对比视图的布局；没有对比视图时为 null。 */
export function compareLayout(): CompareLayout | null {
  return active?.layout() ?? null;
}

/** 把滚轮 / 拖动中尚未写回的视口立即写回 store。 */
export function flushCompareViewport(): void {
  active?.flush();
}

interface Hit {
  id: FileId;
  /** 该格的图片区 */
  pic: HTMLElement;
}

/** 事件落在哪一格（移出按钮上的不算）。 */
function hitCell(target: EventTarget | null): Hit | null {
  if (!(target instanceof Element) || target.closest(".compare-remove")) return null;
  const cell = target.closest<HTMLElement>(".compare-cell");
  const pic = cell?.querySelector<HTMLElement>(".compare-img");
  if (!cell || !pic) return null;
  return { id: Number(cell.dataset.id), pic };
}

/**
 * 对比视图的交互：Ctrl / Cmd + 滚轮（含触控板捏合）缩放、放大后拖动平移、没放大时拖动排序（compareDragSort）、
 * 单击设焦点、双击打开单张、右键菜单。
 * 热路径：交互只改这里的 live 视口，一个 rAF 里遍历挂载中的格子写 transform；
 * 拖动结束或滚轮停下 150 ms 后写回 compareUi。store 的视口被别处改了（键盘、同步开关、进入）时以 store 为准。
 * 渲染时 CompareCell 按 store 的视口写同样格式的 transform：写回之后二者一致，写回之前 React 不会碰它（props 没变）。
 */
export function useCompareViewport(scroller: HTMLElement | null, layout: CompareLayout): void {
  const layoutRef = useRef(layout);
  const repaint = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    layoutRef.current = layout;
    // 格子尺寸变了时 React 按 store 的视口重写；有未写回的交互时以 live 为准再画一次
    repaint.current();
  }, [layout]);

  useEffect(() => {
    if (!scroller) return;
    const init = useCompareUi.getState();
    const live: { viewport: CompareViewport; perCell: Map<FileId, CompareViewport> | null } = {
      viewport: init.viewport,
      perCell: init.perCell,
    };
    let dirty = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const vpOf = (id: FileId) => live.perCell?.get(id) ?? live.viewport;

    const paint = () => {
      frame = 0;
      const { box, sizes } = layoutRef.current;
      if (box.w <= 0 || box.h <= 0) return;
      for (const cell of scroller.querySelectorAll<HTMLElement>(".compare-cell")) {
        const id = Number(cell.dataset.id);
        const img = sizes.get(id);
        if (!img) continue;
        const css = picTransform(vpOf(id), img, box);
        for (const pic of cell.querySelectorAll<HTMLElement>(".compare-pic")) pic.style.transform = css;
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    repaint.current = () => {
      if (dirty) schedule();
    };

    const commit = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!dirty) return;
      dirty = false;
      useCompareUi.getState().commit(live.viewport, live.perCell);
    };

    /** 改一格的 live 视口：同步开时改共享视口，否则只改这一格。 */
    const apply = (id: FileId, fn: (vp: CompareViewport) => CompareViewport) => {
      if (live.perCell === null) {
        const next = fn(live.viewport);
        if (next === live.viewport) return;
        live.viewport = next;
      } else {
        const old = vpOf(id);
        const next = fn(old);
        if (next === old) return;
        live.perCell = new Map(live.perCell).set(id, next);
      }
      dirty = true;
      schedule();
    };

    const unsub = useCompareUi.subscribe((s, prev) => {
      if (s.viewport === prev.viewport && s.perCell === prev.perCell) return;
      if (s.viewport === live.viewport && s.perCell === live.perCell) return;
      // 别处改了视口：放弃未写回的交互，以 store 为准
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      live.viewport = s.viewport;
      live.perCell = s.perCell;
      schedule();
    });

    const local = (e: MouseEvent, pic: HTMLElement): [number, number] => {
      const r = pic.getBoundingClientRect();
      // 图片定位在图片区的内边距盒里：减去边框
      return [e.clientX - r.left - pic.clientLeft, e.clientY - r.top - pic.clientTop];
    };

    const onWheel = (e: WheelEvent) => {
      // 普通滚轮滚动图片墙
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const hit = hitCell(e.target);
      if (!hit) return;
      const { box, sizes } = layoutRef.current;
      const img = sizes.get(hit.id);
      if (!img || box.w <= 0 || box.h <= 0) return;
      const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * box.h : e.deltaY;
      if (dy === 0) return;
      const [px, py] = local(e, hit.pic);
      const f = wheelFactor(dy, e.ctrlKey);
      const anchor = { img, box, px, py };
      const cells = live.perCell === null ? layoutCells(layoutRef.current) : [{ img, box }];
      apply(hit.id, (vp) => zoomAtCell(vp, f, anchor, cells));
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(commit, WHEEL_COMMIT_MS);
    };

    // 按下：记下起点与所在格；该格已放大是平移，否则（不带修饰键时）是排序。
    // moved 是本次按下以来离起点最远的距离，供单击 / 双击判断
    let press: {
      pointerId: number;
      x: number;
      y: number;
      lastX: number;
      lastY: number;
      id: FileId;
      img: Size | null;
      pan: boolean;
      /** 移动够远后可开始排序拖动 */
      sortable: boolean;
      sort: SortDrag | null;
    } | null = null;
    let moved = 0;
    const capture = (pointerId: number) => {
      try {
        scroller.setPointerCapture?.(pointerId);
      } catch {
        // 指针已失效：不捕获也能拖，抬起时照常结束
      }
    };
    /** 结束本次按下；排序拖动按 accept 提交或取消。 */
    const endPress = (accept = true) => {
      if (!press) return;
      const pid = press.pointerId;
      const panned = press.pan;
      const sort = press.sort;
      press = null;
      sort?.finish(accept);
      if (scroller.hasPointerCapture?.(pid)) scroller.releasePointerCapture(pid);
      if (panned) commit();
    };
    const onPointerDown = (e: PointerEvent) => {
      // 排序拖动中又有指针按下（第二根手指、笔、移出按钮）：先取消它，免得临时样式与 Esc 监听留下来
      if (press?.sort) endPress(false);
      if (e.button !== 0) return;
      moved = 0;
      press = null;
      const hit = hitCell(e.target);
      if (!hit) return;
      const { box, sizes } = layoutRef.current;
      const img = sizes.get(hit.id) ?? null;
      const pan = img !== null && box.w > 0 && box.h > 0 && isZoomed(vpOf(hit.id), img, box);
      const sortable = !pan && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
      press = {
        pointerId: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
        id: hit.id, img, pan, sortable, sort: null,
      };
      if (pan) capture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      if ((e.buttons & 1) === 0) {
        endPress();
        return;
      }
      moved = Math.max(moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
      // 移动够远才开始平移或排序，免得单击时抖一下
      if (moved < CLICK_SLOP) return;
      if (!press.pan) {
        if (!press.sort && press.sortable) {
          press.sortable = false;
          press.sort = beginSortDrag(scroller, press.id, press.x, press.y);
          // 排序开始后才捕获：拖出滚动区（含窗口外）后松开仍按最后的目标提交；单击不受捕获影响
          if (press.sort) capture(press.pointerId);
        }
        press.sort?.move(e.clientX, e.clientY);
        return;
      }
      if (!press.img) return;
      const dx = e.clientX - press.lastX;
      const dy = e.clientY - press.lastY;
      press.lastX = e.clientX;
      press.lastY = e.clientY;
      const img = press.img;
      const box = layoutRef.current.box;
      apply(press.id, (vp) => panInCell(vp, dx, dy, img, box));
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      if (e.type === "pointerup") {
        moved = Math.max(moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
        press.sort?.move(e.clientX, e.clientY);
      }
      endPress(e.type !== "pointercancel");
    };

    const onClick = (e: MouseEvent) => {
      const hit = hitCell(e.target);
      if (!hit || moved >= CLICK_SLOP) return;
      useCompareUi.getState().setFocus(hit.id);
    };
    const onDblClick = (e: MouseEvent) => {
      const hit = hitCell(e.target);
      if (!hit || moved >= CLICK_SLOP || layoutRef.current.missing.has(hit.id)) return;
      flushCompareViewport();
      useCompareUi.getState().setFocus(hit.id);
      useNav.getState().openSingle(hit.id, "basket");
    };
    const onContextMenu = (e: MouseEvent) => {
      const hit = hitCell(e.target);
      if (!hit) return;
      e.preventDefault();
      useCompareUi.getState().setFocus(hit.id);
      void showImageMenu();
    };

    const mine = { layout: () => layoutRef.current, flush: commit };
    active = mine;

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerup", onPointerEnd);
    scroller.addEventListener("pointercancel", onPointerEnd);
    scroller.addEventListener("lostpointercapture", onPointerEnd);
    scroller.addEventListener("click", onClick);
    scroller.addEventListener("dblclick", onDblClick);
    scroller.addEventListener("contextmenu", onContextMenu);
    return () => {
      endPress(false);
      commit();
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      repaint.current = () => {};
      unsub();
      if (active === mine) active = null;
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerup", onPointerEnd);
      scroller.removeEventListener("pointercancel", onPointerEnd);
      scroller.removeEventListener("lostpointercapture", onPointerEnd);
      scroller.removeEventListener("click", onClick);
      scroller.removeEventListener("dblclick", onDblClick);
      scroller.removeEventListener("contextmenu", onContextMenu);
    };
  }, [scroller]);
}
