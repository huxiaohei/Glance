// 裁剪框几何：纯函数。矩形都是“转正后、旋转翻转后”画面里的整数像素。
// 取整规则：派生出的宽高与位置一律 Math.round，随后夹进 bounds（w、h ≥ 1）。
import type { CropMemory, CropState } from "../ipc/types";

export type Rect = { x: number; y: number; w: number; h: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";
type Size = { w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function orientedSize(w: number, h: number, turns: number): Size {
  return turns % 2 === 0 ? { w, h } : { w: h, h: w };
}

export function ratioOf(mem: CropMemory): number | null {
  let r: number;
  switch (mem.ratio) {
    case "free": return null;
    case "1:1": return 1;
    case "4:3": r = 4 / 3; break;
    case "16:9": r = 16 / 9; break;
    default:
      if (!Number.isFinite(mem.customW) || !Number.isFinite(mem.customH) || mem.customW < 1 || mem.customH < 1) return null;
      r = mem.customW / mem.customH;
  }
  return mem.portrait ? 1 / r : r;
}

/** 把 (w,h) 按比例缩进 maxW×maxH，结果为整数且 ≥ 1。 */
function fitInside(w: number, h: number, ratio: number | null, maxW: number, maxH: number): Size {
  let rw = Math.max(1, Math.round(w));
  let rh = Math.max(1, Math.round(h));
  if (ratio === null) return { w: Math.min(rw, maxW), h: Math.min(rh, maxH) };
  if (rh > maxH) { rh = maxH; rw = Math.max(1, Math.round(rh * ratio)); }
  if (rw > maxW) { rw = maxW; rh = Math.max(1, Math.min(maxH, Math.round(rw / ratio))); }
  return { w: Math.min(rw, maxW), h: Math.min(rh, maxH) };
}

function centered(cx: number, cy: number, w: number, h: number, bounds: Size): Rect {
  return {
    x: clamp(Math.round(cx - w / 2), 0, bounds.w - w),
    y: clamp(Math.round(cy - h / 2), 0, bounds.h - h),
    w, h,
  };
}

export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, bounds: Size, ratio: number | null): Rect {
  if (handle === "move") {
    return {
      ...start,
      x: clamp(Math.round(start.x + dx), 0, bounds.w - start.w),
      y: clamp(Math.round(start.y + dy), 0, bounds.h - start.h),
    };
  }
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const isCorner = handle.length === 2;

  if (!isCorner) {
    const horizontal = handle === "e" || handle === "w";
    if (horizontal) {
      const room = handle === "e" ? bounds.w - start.x : right;
      const raw = start.w + (handle === "e" ? dx : -dx);
      const w0 = clamp(Math.round(raw), 1, room);
      const { w, h } = ratio === null ? { w: w0, h: start.h } : fitInside(w0, w0 / ratio, ratio, room, bounds.h);
      const x = handle === "e" ? start.x : right - w;
      if (ratio === null) return { x, y: start.y, w, h };
      return { x, y: clamp(Math.round(start.y + start.h / 2 - h / 2), 0, bounds.h - h), w, h };
    }
    const room = handle === "s" ? bounds.h - start.y : bottom;
    const raw = start.h + (handle === "s" ? dy : -dy);
    let h = clamp(Math.round(raw), 1, room);
    if (ratio === null) {
      return { x: start.x, y: handle === "s" ? start.y : bottom - h, w: start.w, h };
    }
    const f = fitInside(h * ratio, h, ratio, bounds.w, room);
    h = f.h;
    const y = handle === "s" ? start.y : bottom - h;
    return { x: clamp(Math.round(start.x + start.w / 2 - f.w / 2), 0, bounds.w - f.w), y, w: f.w, h };
  }

  // 角：对角固定
  const sx = handle.includes("e") ? 1 : -1;
  const sy = handle.includes("s") ? 1 : -1;
  const ax = sx > 0 ? start.x : right;
  const ay = sy > 0 ? start.y : bottom;
  const roomW = sx > 0 ? bounds.w - ax : ax;
  const roomH = sy > 0 ? bounds.h - ay : ay;
  const rawW = start.w + sx * dx;
  const rawH = start.h + sy * dy;
  let w: number;
  let h: number;
  if (ratio === null) {
    w = clamp(Math.round(rawW), 1, roomW);
    h = clamp(Math.round(rawH), 1, roomH);
  } else {
    // 变化幅度大的那一边说了算
    const byW = Math.abs(rawW / start.w - 1) >= Math.abs(rawH / start.h - 1);
    const wf = byW ? rawW : rawH * ratio;
    ({ w, h } = fitInside(wf, wf / ratio, ratio, roomW, roomH));
  }
  return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
}

export function fitRatio(current: Rect, ratio: number, bounds: Size): Rect {
  const { w, h } = fitInside(Math.min(bounds.w, bounds.h * ratio), Math.min(bounds.w / ratio, bounds.h), ratio, bounds.w, bounds.h);
  return centered(current.x + current.w / 2, current.y + current.h / 2, w, h, bounds);
}

export function resizeTo(current: Rect, w: number | null, h: number | null, ratio: number | null, bounds: Size): Rect {
  let nw = current.w;
  let nh = current.h;
  if (w !== null) {
    nw = w;
    nh = ratio !== null ? w / ratio : h ?? current.h;
  } else if (h !== null) {
    nh = h;
    nw = ratio !== null ? h * ratio : current.w;
  }
  const f = fitInside(nw, nh, ratio, bounds.w, bounds.h);
  return centered(current.x + current.w / 2, current.y + current.h / 2, f.w, f.h, bounds);
}

function swapIfOne(s: CropState): Pick<CropState, "flipH" | "flipV"> {
  return s.flipH !== s.flipV ? { flipH: !s.flipH, flipV: !s.flipV } : { flipH: s.flipH, flipV: s.flipV };
}

/** dims 为转正原图尺寸；rect 跟着内容转。R∘F_h = F_v∘R，故仅一个翻转时互换两个标记。 */
export function rotate(state: CropState, dir: 1 | -1, dims: Size): CropState {
  const o = orientedSize(dims.w, dims.h, state.quarterTurns);
  const { x, y, w, h } = state.rect;
  const rect: Rect = dir === 1
    ? { x: o.h - y - h, y: x, w: h, h: w }
    : { x: y, y: o.w - x - w, w: h, h: w };
  return { rect, quarterTurns: ((state.quarterTurns + (dir === 1 ? 1 : 3)) % 4) as CropState["quarterTurns"], ...swapIfOne(state) };
}

/** 作用于当前显示画面（已转后）。 */
export function flip(state: CropState, axis: "h" | "v", dims: Size): CropState {
  const o = orientedSize(dims.w, dims.h, state.quarterTurns);
  const r = state.rect;
  return axis === "h"
    ? { ...state, rect: { ...r, x: o.w - r.x - r.w }, flipH: !state.flipH }
    : { ...state, rect: { ...r, y: o.h - r.y - r.h }, flipV: !state.flipV };
}

export function cssTransform(state: CropState): string {
  return `scale(${state.flipH ? -1 : 1}, ${state.flipV ? -1 : 1}) rotate(${90 * state.quarterTurns}deg)`;
}
