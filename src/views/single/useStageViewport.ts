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
import { createWheelStepper } from "../../lib/wheelStep";
import { editActive, inBatch } from "../../stores/editUi";
import { useSettings } from "../../stores/settings";
import { go } from "./go";

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
  /** 跟随图片的叠层（编辑结果）：写上与图片相同的宽高与 transform，结果图因此按原图尺寸铺放。 */
  overlay?: HTMLElement | null;
  /**
   * 单击（主键按下到抬起移动 < CLICK_SLOP）落在图片上时回调，坐标为 size（图片像素）下的位置；
   * 拖动平移与双击照常。
   */
  onTap?(ix: number, iy: number): void;
}): { api: StageApi; percent: number } {
  const { box, img, size, imageKey } = args;
  const overlay = args.overlay ?? null;
  const [percent, setPercent] = useState(0);

  // 全部可变状态放在一个 ref 里，监听器与 api 读到的总是最新值
  const st = useRef({
    box: null as HTMLElement | null,
    img: null as HTMLImageElement | null,
    overlay: null as HTMLElement | null,
    size: null as Size | null,
    natural: null as Size | null,
    key: null as string | null,
    vp: null as Viewport | null,
    dragging: false,
    frame: null as number | null,
    onTap: undefined as ((ix: number, iy: number) => void) | undefined,
  }).current;
  // 监听器在事件发生时读最新的回调
  const onTap = args.onTap;
  useLayoutEffect(() => {
    st.onTap = onTap;
  }, [st, onTap]);

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
      const transform = st.vp ? `translate(${st.vp.x}px, ${st.vp.y}px) scale(${st.vp.scale})` : "";
      if (el) {
        if (st.vp && i) {
          el.style.width = `${i.w}px`;
          el.style.height = `${i.h}px`;
          el.style.transform = transform;
          el.style.visibility = "";
        } else {
          el.style.transform = "";
          el.style.visibility = "hidden";
        }
      }
      const ov = st.overlay;
      if (ov) {
        if (st.vp && i) {
          ov.style.width = `${i.w}px`;
          ov.style.height = `${i.h}px`;
          ov.style.transform = transform;
          // 叠层里按屏幕像素画的图案（去背景的棋盘格）据此抵消缩放
          ov.style.setProperty("--view-scale", String(st.vp.scale));
        } else {
          ov.style.transform = "";
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

    /** 容器内坐标换成图片像素坐标；没有视口或落在图片之外时为 null。 */
    const toImage = (px: number, py: number): [number, number] | null => {
      const i = imgSize();
      const v = st.vp;
      if (!v || !i) return null;
      const ix = (px - v.x) / v.scale;
      const iy = (py - v.y) / v.scale;
      return ix >= 0 && iy >= 0 && ix < i.w && iy < i.h ? [ix, iy] : null;
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
    return { api, update, relayout, paint, canPan, toImage };
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

  // 叠层：挂上后写上当前视口
  useLayoutEffect(() => {
    st.overlay = overlay;
    if (overlay) ctl.paint();
  }, [overlay, st, ctl]);

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

    // React 的 onWheel 是被动监听，拦不住页面滚动与缩放：手动挂非被动监听。
    // 设置为“滚轮切图”时，不按 Ctrl / Cmd 的滚轮交给步进器切图；按住时（含触控板捏合）仍缩放。
    // 设置在每次事件时读取，改完即生效
    const stepWheel = createWheelStepper();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * box.clientHeight : e.deltaY;
      if (dy === 0) return;
      // 编辑模式中不切图（批量模式除外，go 转给 batchStep），滚轮照常缩放
      if (useSettings.getState().settings.wheel === "switch" && !e.ctrlKey && !e.metaKey && (!editActive() || inBatch())) {
        const dir = stepWheel(dy, performance.now());
        if (dir !== 0) go(dir > 0 ? "next" : "prev");
        return;
      }
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
      let tap = false;
      if (start && e.type === "pointerup") {
        moved = Math.max(moved, Math.hypot(e.clientX - start.x, e.clientY - start.y));
        tap = moved < CLICK_SLOP;
      }
      start = null;
      if (drag && e.pointerId === drag.id) endDrag();
      if (tap && st.onTap) {
        const [px, py] = local(e);
        const at = ctl.toImage(px, py);
        if (at) st.onTap(at[0], at[1]);
      }
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
