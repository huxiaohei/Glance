import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  actualSize,
  fitViewport,
  panBy,
  resizeViewport,
  toggleFit,
  wheelFactor,
  zoomAt,
  type Size,
  type Viewport,
} from "../../lib/viewport";

export interface StageApi {
  zoomBy(factor: number): void;     // 以容器中心为准
  fit(): void;
  actual(): void;                   // 以容器中心为准
}

/** 按下到抬起移动不足这么多像素仍算单击（不影响双击）。 */
const CLICK_SLOP = 4;
/** 按行滚动（deltaMode 1）时一行折合的像素。 */
const LINE_PX = 16;

type Op = (v: Viewport, img: Size, box: Size) => Viewport;

const validSize = (s: Size | null | undefined): s is Size => !!s && s.w > 0 && s.h > 0;

/** 读自然尺寸；loaded 为假时只在图片已加载完成时读，否则 null。 */
function readNatural(img: HTMLImageElement, loaded = false): Size | null {
  const s = { w: img.naturalWidth, h: img.naturalHeight };
  return (loaded || img.complete) && validSize(s) ? s : null;
}

/**
 * 单张视图的视口：保存在 ref 里，变化时直接写 img 的 style（宽高为图片像素，transform 为
 * translate + scale，transform-origin 由样式表给 0 0），不触发 React 渲染；百分比每帧最多更新一次。
 * 手势监听都挂在容器上，图片元素可以随时替换，替换后重新写上当前视口。
 */
export function useStageViewport(args: {
  box: HTMLElement | null;
  img: HTMLImageElement | null;
  size: Size | null;                // 条目的宽高；为 null 时等图片 load 后用 naturalWidth / naturalHeight
  imageKey: string;                 // 换图时变化 → 回到适应窗口
}): { api: StageApi; percent: number } {
  const { box, img, size, imageKey } = args;
  const [percent, setPercent] = useState(0);

  // 全部可变状态放在一个 ref 里，监听器与 api 读到的总是最新值
  const st = useRef({
    box: null as HTMLElement | null,
    img: null as HTMLImageElement | null,
    size: null as Size | null,
    natural: null as Size | null,
    key: null as string | null,
    vp: null as Viewport | null,
    dragging: false,
    frame: null as number | null,
  }).current;

  const ctl = useMemo(() => {
    const imgSize = (): Size | null => (validSize(st.size) ? st.size : st.natural);
    const boxSize = (): Size | null => {
      const s = st.box ? { w: st.box.clientWidth, h: st.box.clientHeight } : null;
      return validSize(s) ? s : null;
    };
    const canPan = (): boolean => {
      const i = imgSize();
      const b = boxSize();
      if (!st.vp || !i || !b) return false;
      return i.w * st.vp.scale > b.w + 0.5 || i.h * st.vp.scale > b.h + 0.5;
    };

    const schedulePercent = () => {
      if (st.frame !== null) return;
      st.frame = requestAnimationFrame(() => {
        st.frame = null;
        setPercent(st.vp ? Math.round(st.vp.scale * 100) : 0);
      });
    };

    /** 把当前视口写到图片与容器的 style 上。 */
    const paint = () => {
      const i = imgSize();
      const el = st.img;
      if (el) {
        if (st.vp && i) {
          el.style.width = `${i.w}px`;
          el.style.height = `${i.h}px`;
          el.style.transform = `translate(${st.vp.x}px, ${st.vp.y}px) scale(${st.vp.scale})`;
          el.style.visibility = "";
        } else {
          el.style.transform = "";
          el.style.visibility = "hidden";
        }
      }
      if (st.box) st.box.style.cursor = st.dragging ? "grabbing" : canPan() ? "grab" : "";
      schedulePercent();
    };

    /** 尺寸都已知而还没有视口时，先适应窗口。返回是否有视口。 */
    const ensure = (): boolean => {
      if (st.vp) return true;
      const i = imgSize();
      const b = boxSize();
      if (!i || !b) return false;
      st.vp = fitViewport(i, b);
      return true;
    };

    const update = (op: Op) => {
      const i = imgSize();
      const b = boxSize();
      if (!ensure() || !i || !b) return;
      st.vp = op(st.vp!, i, b);
      paint();
    };

    /** 容器或图片尺寸变了：已有视口走 resizeViewport，否则尝试初次适应。 */
    const relayout = () => {
      const i = imgSize();
      const b = boxSize();
      if (st.vp && i && b) st.vp = resizeViewport(st.vp, i, b);
      else ensure();
      paint();
    };

    const center = (): [number, number] => {
      const b = boxSize();
      return b ? [b.w / 2, b.h / 2] : [0, 0];
    };

    const api: StageApi = {
      zoomBy: (factor) => {
        const [cx, cy] = center();
        update((v, i, b) => zoomAt(v, factor, cx, cy, i, b));
      },
      fit: () => update((_v, i, b) => fitViewport(i, b)),
      actual: () => {
        const [cx, cy] = center();
        update((v, i, b) => actualSize(v, cx, cy, i, b));
      },
    };
    return { api, update, relayout, paint, canPan };
  }, [st]);

  // 换图：清掉旧视口与自然尺寸，回到适应窗口；同一张图的尺寸变化（例如尺寸后补到达）走 resizeViewport。
  // 须在下面的 img 效果之前。自然尺寸只从本次渲染的元素读：元素可能与 imageKey 在同一次提交里替换，
  // 此时 st.img 还是旧元素
  const sw = size?.w;
  const sh = size?.h;
  useLayoutEffect(() => {
    st.size = sw !== undefined && sh !== undefined ? { w: sw, h: sh } : null;
    if (st.key !== imageKey) {
      st.key = imageKey;
      st.vp = null;
      st.natural = img ? readNatural(img) : null;
    }
    ctl.relayout();
    // img 只在换图时读取，不作为依赖：元素替换由下面的效果处理
  }, [imageKey, sw, sh, st, ctl]);

  // 图片元素：可能被替换；替换后自然尺寸以新元素为准（未加载完则等 load），并写上当前视口
  useLayoutEffect(() => {
    st.img = img;
    if (!img) return;
    st.natural = readNatural(img);
    ctl.relayout();
    const onLoad = () => {
      if (st.img !== img) return;
      st.natural = readNatural(img, true);
      ctl.relayout();
    };
    img.addEventListener("load", onLoad);
    return () => img.removeEventListener("load", onLoad);
  }, [img, st, ctl]);

  // 容器：尺寸监听与全部手势
  useLayoutEffect(() => {
    st.box = box;
    if (!box) return;
    ctl.relayout();

    const local = (e: MouseEvent): [number, number] => {
      const r = box.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const ro = new ResizeObserver(() => ctl.relayout());
    ro.observe(box);

    // React 的 onWheel 是被动监听，拦不住页面滚动与缩放：手动挂非被动监听
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * box.clientHeight : e.deltaY;
      if (dy === 0) return;
      const [px, py] = local(e);
      const f = wheelFactor(dy, e.ctrlKey);
      ctl.update((v, i, b) => zoomAt(v, f, px, py, i, b));
    };

    // 拖拽：pointerId 与上一个位置；moved 记录本次按下以来离起点最远的距离，供双击判断
    let drag: { id: number; x: number; y: number } | null = null;
    let start: { x: number; y: number } | null = null;
    let moved = 0;
    const endDrag = () => {
      if (!drag) return;
      const id = drag.id;
      drag = null;
      st.dragging = false;
      if (box.hasPointerCapture?.(id)) box.releasePointerCapture(id);
      ctl.paint();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      moved = 0;
      if (!ctl.canPan()) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      st.dragging = true;
      try {
        box.setPointerCapture?.(e.pointerId);
      } catch {
        // 指针已失效：不捕获也能拖，抬起时照常结束
      }
      ctl.paint();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (start && (e.buttons & 1) === 1) {
        moved = Math.max(moved, Math.hypot(e.clientX - start.x, e.clientY - start.y));
      }
      if (!drag || e.pointerId !== drag.id) return;
      if ((e.buttons & 1) === 0) {
        endDrag();
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      ctl.update((v, i, b) => panBy(v, dx, dy, i, b));
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (start && e.type === "pointerup") {
        moved = Math.max(moved, Math.hypot(e.clientX - start.x, e.clientY - start.y));
      }
      start = null;
      if (drag && e.pointerId === drag.id) endDrag();
    };
    const onDblClick = (e: MouseEvent) => {
      if (moved >= CLICK_SLOP) return;
      const [px, py] = local(e);
      ctl.update((v, i, b) => toggleFit(v, px, py, i, b));
    };

    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("pointerdown", onPointerDown);
    box.addEventListener("pointermove", onPointerMove);
    box.addEventListener("pointerup", onPointerEnd);
    box.addEventListener("pointercancel", onPointerEnd);
    box.addEventListener("lostpointercapture", onPointerEnd);
    box.addEventListener("dblclick", onDblClick);
    return () => {
      ro.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("pointerdown", onPointerDown);
      box.removeEventListener("pointermove", onPointerMove);
      box.removeEventListener("pointerup", onPointerEnd);
      box.removeEventListener("pointercancel", onPointerEnd);
      box.removeEventListener("lostpointercapture", onPointerEnd);
      box.removeEventListener("dblclick", onDblClick);
      drag = null;
      st.dragging = false;
    };
  }, [box, st, ctl]);

  useEffect(
    () => () => {
      if (st.frame !== null) cancelAnimationFrame(st.frame);
      st.frame = null;
    },
    [st],
  );

  return { api: ctl.api, percent };
}
