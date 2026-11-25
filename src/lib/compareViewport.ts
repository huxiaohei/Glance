import { MAX_SCALE, clampViewport, fitScale, type Size, type Viewport } from "./viewport";

/** rel：每格实际倍率 = 该格 fit × k（k ≥ 1）；px：每格实际倍率都是 s。 */
export type CompareScale = { kind: "rel"; k: number } | { kind: "px"; s: number };

/** 对比视图的共享视口。(u, v) 是格子中心对准的图片相对位置（0–1），存未夹的值。 */
export interface CompareViewport {
  scale: CompareScale;
  u: number;
  v: number;
}

export const FIT_VIEWPORT: CompareViewport = { scale: { kind: "rel", k: 1 }, u: 0.5, v: 0.5 };

const EPS = 1e-6;

/** 这一格的实际倍率：rel → fitScale(img, box) × k；px → s。 */
export function cellScale(vp: CompareViewport, img: Size, box: Size): number {
  return vp.scale.kind === "rel" ? fitScale(img, box) * vp.scale.k : vp.scale.s;
}

/** 这一格的 transform：按倍率与 (u,v) 求出位置，再夹到不露空白（图比格小的方向居中）。不改 vp。 */
export function cellTransform(vp: CompareViewport, img: Size, box: Size): Viewport {
  const scale = cellScale(vp, img, box);
  const raw: Viewport = {
    scale,
    x: box.w / 2 - vp.u * img.w * scale,
    y: box.h / 2 - vp.v * img.h * scale,
    fit: Math.abs(scale - fitScale(img, box)) < EPS,
  };
  return clampViewport(raw, img, box);
}

function withScale(vp: CompareViewport, scale: CompareScale): CompareViewport {
  return { ...vp, scale };
}

/** 按上下限求缩放后的倍率；px 缩到每格都不大于各自 fit 时返回 rel k=1。 */
function nextScale(scale: CompareScale, f: number, cells: { img: Size; box: Size }[]): CompareScale {
  const fits = cells.map((c) => fitScale(c.img, c.box));
  if (scale.kind === "rel") {
    const cap = Math.max(1, Math.min(...fits.map((fs) => MAX_SCALE / fs)));
    const k = Math.min(cap, Math.max(1, scale.k * f));
    // 已超过上限（例如格子变了）时放大不反而缩小。
    return { kind: "rel", k: f > 1 ? Math.max(scale.k, k) : k };
  }
  const capped = Math.min(MAX_SCALE, scale.s * f);
  const s = f > 1 ? Math.max(scale.s, capped) : capped;
  if (fits.every((fs) => s <= fs + EPS)) return { kind: "rel", k: 1 };
  return { kind: "px", s };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function sameScale(a: CompareScale, b: CompareScale): boolean {
  if (a.kind === "rel" && b.kind === "rel") return Math.abs(a.k - b.k) < EPS;
  if (a.kind === "px" && b.kind === "px") return Math.abs(a.s - b.s) < EPS;
  return false;
}

/** 以某格内的点 (px,py) 为锚缩放 factor 倍：缩放后该图点仍在 (px,py) 下（按夹取前的位置算）。
 *  上限：所有格 cellScale 都不超过 MAX_SCALE（以最先触顶的格为准）。
 *  下限：rel 下 k 不小于 1；px 下若所有格都已不大于各自 fit，转成 rel k=1。
 *  转成 rel k=1 时保留的是按锚点换算后的 (u,v)（以转换前的 px 倍率算）。
 *  结果的 u,v 夹到 [0,1]。
 *  cells 应包含锚点格；为空时只以锚点格为准。倍率没有变化时原样返回 vp。 */
export function zoomAtCell(
  vp: CompareViewport,
  factor: number,
  anchorCell: { img: Size; box: Size; px: number; py: number },
  cells: { img: Size; box: Size }[],
): CompareViewport {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const { img, box, px, py } = anchorCell;
  const all = cells.length > 0 ? cells : [{ img, box }];
  const next = nextScale(vp.scale, f, all);
  if (sameScale(next, vp.scale)) return vp;
  if (!(img.w > 0) || !(img.h > 0)) return withScale(vp, next);

  // 锚点下的图点一律按未夹的位置（由 vp 的 u,v 求）算：共享坐标优先。若按夹取后的位置算，
  // 锚点格在某方向居中或贴边时共享的 u/v 会被拉动，其他格跟着跳；代价是锚点格贴边时
  // 缩放后该点可能偏离鼠标几个像素。
  const s0 = cellScale(vp, img, box);
  const ix = (px - (box.w / 2 - vp.u * img.w * s0)) / s0;
  const iy = (py - (box.h / 2 - vp.v * img.h * s0)) / s0;
  // px → rel k=1 时用转换前的 px 倍率求锚点，保证 (u,v) 是“缩放后”的值。
  const s =
    next.kind === "rel" && vp.scale.kind === "px"
      ? vp.scale.s * f
      : cellScale(withScale(vp, next), img, box);
  return {
    scale: next,
    u: clamp01(ix / img.w - (px - box.w / 2) / (s * img.w)),
    v: clamp01(iy / img.h - (py - box.h / 2) / (s * img.h)),
  };
}

/** 一个方向上 u 的合法范围：图大于格时是该格不露空白的范围，否则 [0,1]。 */
function panAxis(pos: number, delta: number, scale: number, content: number, container: number): number {
  const next = pos - delta / (scale * content);
  if (content * scale <= container + EPS) return clamp01(next);
  const half = container / 2 / (scale * content);
  return Math.min(1 - half, Math.max(half, next));
}

/** 在某格里拖动 (dx,dy) 屏幕像素：按该格实际倍率换成 Δu、Δv。
 *  图在该方向大于格子时夹到这一格不露空白的范围（存的值就是这格看到的，拖回来没有死区），
 *  否则夹到 [0,1]。 */
export function panInCell(vp: CompareViewport, dx: number, dy: number, img: Size, box: Size): CompareViewport {
  const s = cellScale(vp, img, box);
  if (!(s > 0) || !(img.w > 0) || !(img.h > 0)) return vp;
  return { ...vp, u: panAxis(vp.u, dx, s, img.w, box.w), v: panAxis(vp.v, dy, s, img.h, box.h) };
}

/** 逐像素 100%：px s=1，保留 u,v。 */
export function actualSizeViewport(vp: CompareViewport): CompareViewport {
  return withScale(vp, { kind: "px", s: 1 });
}

/** 全部适应格子：与 FIT_VIEWPORT 相同的新对象。 */
export function fitAllViewport(): CompareViewport {
  return { scale: { kind: "rel", k: 1 }, u: 0.5, v: 0.5 };
}

/** 图在任一方向大于格子。 */
export function isZoomed(vp: CompareViewport, img: Size, box: Size): boolean {
  const s = cellScale(vp, img, box);
  return img.w * s > box.w + EPS || img.h * s > box.h + EPS;
}
