import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { editSourceUrl } from "../../ipc/api";
import { cssTransform, dragRect, orientedSize, ratioOf, type Handle, type Rect } from "../../lib/cropGeometry";
import { useEditUi } from "../../stores/editUi";
import { setSaveMenuOpen } from "../../stores/saveMenu";
import "./edit.css";

/** 四周留白（每边 32 px）。 */
const PAD = 64;
/** 框在屏幕上小于这个尺寸时只留四角的控制点，免得重叠。 */
const SMALL_PX = 48;

const HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export interface CropLayout {
  scale: number;
  /** 未旋转的源图：左上角与显示尺寸 */
  imgLeft: number;
  imgTop: number;
  imgW: number;
  imgH: number;
  /** 转后画面（裁剪框所在的坐标系）的左上角与显示尺寸 */
  frameLeft: number;
  frameTop: number;
  frameW: number;
  frameH: number;
}

/** 适应窗口、四周留 32 px（可放大）。w、h 为转正原图尺寸，turns 为当前旋转。 */
export function cropLayout(boxW: number, boxH: number, w: number, h: number, turns: number): CropLayout | null {
  const o = orientedSize(w, h, turns);
  const scale = Math.min((boxW - PAD) / o.w, (boxH - PAD) / o.h);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const imgW = w * scale;
  const imgH = h * scale;
  const frameW = o.w * scale;
  const frameH = o.h * scale;
  return {
    scale,
    imgLeft: (boxW - imgW) / 2,
    imgTop: (boxH - imgH) / 2,
    imgW,
    imgH,
    frameLeft: (boxW - frameW) / 2,
    frameTop: (boxH - frameH) / 2,
    frameW,
    frameH,
  };
}

interface Drag {
  handle: Handle;
  sx: number;
  sy: number;
  start: Rect;
  latest: Rect;
  scale: number;
  bounds: { w: number; h: number };
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * 裁剪页的画面：盖在舞台上，显示后端转正后的源图（代理图），按适应窗口布局，旋转翻转用 CSS transform 呈现；
 * 不缩放平移（pointerdown、wheel、dblclick 在这里截住，不冒泡到舞台的原生监听）。
 * 裁剪框画在转后画面里：8 个控制点、框外变暗、三分线。拖动中只直接写 DOM，抬起时才写进 store。
 */
export default function CropStage() {
  const opened = useEditUi((s) => s.opened);
  const cs = useEditUi((s) => s.cropState);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxEl = useRef<HTMLDivElement>(null);
  const shadeEl = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    if (!root) return;
    const measure = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  const layout = opened && cs ? cropLayout(box.w, box.h, opened.width, opened.height, cs.quarterTurns) : null;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** 把框与变暗层写到 r 的位置（热路径：不走 React）。 */
  const paint = useCallback((r: Rect) => {
    const l = layoutRef.current;
    const b = boxEl.current;
    const s = shadeEl.current;
    if (!l || !b || !s) return;
    const x = r.x * l.scale;
    const y = r.y * l.scale;
    const w = r.w * l.scale;
    const h = r.h * l.scale;
    b.style.left = `${l.frameLeft + x}px`;
    b.style.top = `${l.frameTop + y}px`;
    b.style.width = `${w}px`;
    b.style.height = `${h}px`;
    b.classList.toggle("is-small", w < SMALL_PX || h < SMALL_PX);
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.width = `${w}px`;
    s.style.height = `${h}px`;
  }, []);

  // 每次渲染后按 store（拖动中按拖动的最新值）重画
  useLayoutEffect(() => {
    const r = drag.current?.latest ?? cs?.rect;
    if (r) paint(r);
  });

  useEffect(() => {
    if (!root) return;
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      // 主键已松开（pointerup 丢了，例如在窗口外松开）：按最后的位置收尾
      if ((e.buttons & 1) === 0) {
        onUp();
        return;
      }
      let ratio = ratioOf(useEditUi.getState().crop);
      // 自由比例时按住 Shift 锁定起始比例
      if (ratio === null && e.shiftKey && d.handle !== "move") ratio = d.start.w / d.start.h;
      d.latest = dragRect(d.start, d.handle, (e.clientX - d.sx) / d.scale, (e.clientY - d.sy) / d.scale, d.bounds, ratio);
      paint(d.latest);
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      end();
      const s = useEditUi.getState();
      if (s.cropState && !sameRect(d.latest, s.cropState.rect)) s.setCropState({ ...s.cropState, rect: d.latest });
      else paint(s.cropState?.rect ?? d.latest);
    };
    const onDown = (e: PointerEvent) => {
      e.stopPropagation();
      // 截住了冒泡：保存旁的下拉靠 document 上的监听收起，这里替它收
      setSaveMenuOpen(false);
      if (e.button !== 0 || drag.current) return;
      const target = e.target instanceof Element ? e.target.closest("[data-handle]") : null;
      const s = useEditUi.getState();
      const l = layoutRef.current;
      if (!target || !s.cropState || !s.opened || !l) return;
      e.preventDefault();
      const start = s.cropState.rect;
      drag.current = {
        handle: target.getAttribute("data-handle") as Handle,
        sx: e.clientX,
        sy: e.clientY,
        start,
        latest: start,
        scale: l.scale,
        bounds: orientedSize(s.opened.width, s.opened.height, s.cropState.quarterTurns),
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDbl = (e: MouseEvent) => e.stopPropagation();
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("dblclick", onDbl);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("dblclick", onDbl);
      end();
      drag.current = null;
    };
  }, [root, paint]);

  return (
    <div className="crop-stage" ref={setRoot}>
      {layout && opened && cs && (
        <>
          <img
            className="crop-img"
            src={editSourceUrl(opened.session)}
            alt=""
            draggable={false}
            style={{
              left: layout.imgLeft,
              top: layout.imgTop,
              width: layout.imgW,
              height: layout.imgH,
              transform: cssTransform(cs),
            }}
          />
          <div
            className="crop-clip"
            style={{ left: layout.frameLeft, top: layout.frameTop, width: layout.frameW, height: layout.frameH }}
          >
            <div className="crop-shade" ref={shadeEl} />
          </div>
          <div className="crop-box" ref={boxEl} data-handle="move">
            <div className="crop-line crop-v1" />
            <div className="crop-line crop-v2" />
            <div className="crop-line crop-h1" />
            <div className="crop-line crop-h2" />
            {HANDLES.map((h) => (
              <div key={h} className={`crop-handle crop-${h}`} data-handle={h} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
