import { describe, expect, it } from "vitest";
import {
  FIT_VIEWPORT,
  actualSizeViewport,
  cellScale,
  cellTransform,
  fitAllViewport,
  isZoomed,
  panInCell,
  zoomAtCell,
  type CompareViewport,
} from "./compareViewport";
import { MAX_SCALE, type Size } from "./viewport";

const box: Size = { w: 200, h: 300 };
const tall: Size = { w: 1000, h: 1500 }; // fit 0.2
const wide: Size = { w: 1500, h: 1000 }; // fit 0.1333…
const small: Size = { w: 100, h: 100 }; // fit 1

const rel = (k: number, u = 0.5, v = 0.5): CompareViewport => ({ scale: { kind: "rel", k }, u, v });
const px = (s: number, u = 0.5, v = 0.5): CompareViewport => ({ scale: { kind: "px", s }, u, v });

/** 格子中心下的图片相对坐标。 */
function centrePoint(vp: CompareViewport, img: Size) {
  const t = cellTransform(vp, img, box);
  return { u: (box.w / 2 - t.x) / (t.scale * img.w), v: (box.h / 2 - t.y) / (t.scale * img.h) };
}

describe("cellScale", () => {
  it("rel 是 fit × k，px 是 s", () => {
    expect(cellScale(rel(2), tall, box)).toBeCloseTo(0.4);
    expect(cellScale(px(1), tall, box)).toBeCloseTo(1);
  });
});

describe("cellTransform", () => {
  it("FIT 时居中且倍率等于 fit", () => {
    const t = cellTransform(FIT_VIEWPORT, wide, box);
    expect(t.scale).toBeCloseTo(0.2 / 1.5);
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBeCloseTo((300 - 1000 * (0.2 / 1.5)) / 2);
    expect(t.fit).toBe(true);
  });

  it("rel k=2、u=v=0.5 时图中心在格中心", () => {
    const t = cellTransform(rel(2), tall, box);
    expect(t.scale).toBeCloseTo(0.4);
    expect(t.x + (1000 * 0.4) / 2).toBeCloseTo(100);
    expect(t.y + (1500 * 0.4) / 2).toBeCloseTo(150);
    expect(t.fit).toBe(false);
  });

  it("u=0 时夹到图左边对齐格左边，不改 vp", () => {
    const vp = rel(2, 0, 0.5);
    const t = cellTransform(vp, tall, box);
    expect(t.x).toBeCloseTo(0);
    expect(vp).toEqual(rel(2, 0, 0.5));
  });

  it("同一 vp 下两张不同宽高比的图，格中心对准的相对坐标相同（未触边）", () => {
    const vp = rel(2, 0.6, 0.5);
    const a = centrePoint(vp, tall);
    const b = centrePoint(vp, wide);
    expect(a.u).toBeCloseTo(0.6);
    expect(a.v).toBeCloseTo(0.5);
    expect(b.u).toBeCloseTo(0.6);
    expect(b.v).toBeCloseTo(0.5);
  });
});

describe("zoomAtCell", () => {
  const cells = [
    { img: tall, box },
    { img: wide, box },
  ];

  it("锚点在格中心、factor 2：k 从 1 到 2，u,v 不变", () => {
    const r = zoomAtCell(FIT_VIEWPORT, 2, { img: tall, box, px: 100, py: 150 }, cells);
    expect(r.scale).toEqual({ kind: "rel", k: 2 });
    expect(r.u).toBeCloseTo(0.5);
    expect(r.v).toBeCloseTo(0.5);
  });

  it("锚点在左上四分之一处：缩放后该图点仍在锚点下", () => {
    const anchor = { img: tall, box, px: 50, py: 75 };
    const before = cellTransform(FIT_VIEWPORT, tall, box);
    const ix = (50 - before.x) / before.scale;
    const iy = (75 - before.y) / before.scale;
    const r = zoomAtCell(FIT_VIEWPORT, 2, anchor, cells);
    const after = cellTransform(r, tall, box);
    expect(after.scale).toBeCloseTo(0.4);
    expect(after.x + ix * after.scale).toBeCloseTo(50);
    expect(after.y + iy * after.scale).toBeCloseTo(75);
  });

  it("某格先触 MAX_SCALE 时 k 停在使该格恰为 16 的值", () => {
    const withSmall = [...cells, { img: small, box }];
    const r = zoomAtCell(rel(10), 4, { img: tall, box, px: 100, py: 150 }, withSmall);
    expect(r.scale).toEqual({ kind: "rel", k: 16 });
    expect(cellScale(r, small, box)).toBeCloseTo(MAX_SCALE);
  });

  it("px 下 s 不超过 MAX_SCALE", () => {
    const r = zoomAtCell(px(10), 4, { img: tall, box, px: 100, py: 150 }, cells);
    expect(r.scale).toEqual({ kind: "px", s: MAX_SCALE });
  });

  it("rel k=1 再缩小不变", () => {
    const vp = rel(1, 0.3, 0.7);
    const r = zoomAtCell(vp, 0.5, { img: tall, box, px: 20, py: 30 }, cells);
    expect(r).toEqual(vp);
  });

  it("rel 缩小不低于 k=1", () => {
    const r = zoomAtCell(rel(1.5), 0.5, { img: tall, box, px: 100, py: 150 }, cells);
    expect(r.scale).toEqual({ kind: "rel", k: 1 });
  });

  it("px s=1 缩小到各格都不大于 fit 时转成 rel k=1", () => {
    const r = zoomAtCell(px(1), 0.1, { img: tall, box, px: 100, py: 150 }, cells);
    expect(r.scale).toEqual({ kind: "rel", k: 1 });
    expect(r.u).toBeCloseTo(0.5);
    expect(r.v).toBeCloseTo(0.5);
  });

  it("px 缩小但仍有格子大于 fit 时保持 px", () => {
    const r = zoomAtCell(px(1), 0.5, { img: tall, box, px: 100, py: 150 }, cells);
    expect(r.scale).toEqual({ kind: "px", s: 0.5 });
  });

  it("已超过上限时再放大不变", () => {
    const vp = rel(20);
    expect(zoomAtCell(vp, 2, { img: small, box, px: 100, py: 150 }, [{ img: small, box }])).toEqual(vp);
  });

  it("锚点格在某方向居中时，该方向的共享坐标不被拉回 0.5", () => {
    const vp = rel(2, 0.5, 0.2);
    const r = zoomAtCell(vp, 1.05, { img: wide, box, px: 100, py: 150 }, cells);
    expect(r.scale.kind).toBe("rel");
    expect(r.u).toBeCloseTo(0.5);
    expect(r.v).toBeCloseTo(0.2);
  });

  it("结果的 u,v 夹在 [0,1]", () => {
    const r = zoomAtCell(px(1), 0.1, { img: tall, box: { w: 1000, h: 1500 }, px: 20, py: 30 }, [
      { img: tall, box: { w: 1000, h: 1500 } },
    ]);
    expect(r.scale).toEqual({ kind: "rel", k: 1 });
    for (const n of [r.u, r.v]) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it("cells 为空时只以锚点格为准", () => {
    const r = zoomAtCell(rel(70), 2, { img: tall, box, px: 100, py: 150 }, []);
    expect(r.scale).toEqual({ kind: "rel", k: 80 });
  });
});

describe("panInCell", () => {
  it("rel k=2（倍率 0.4）里 dx=-40：u 增加 0.1", () => {
    const r = panInCell(rel(2), -40, 0, tall, box);
    expect(r.u).toBeCloseTo(0.6);
    expect(r.v).toBeCloseTo(0.5);
    expect(r.scale).toEqual({ kind: "rel", k: 2 });
  });

  it("dy 同理换算成 Δv", () => {
    const r = panInCell(rel(2), 0, 60, tall, box);
    expect(r.v).toBeCloseTo(0.5 - 60 / (0.4 * 1500));
  });

  it("u,v 夹在 [0,1]", () => {
    expect(panInCell(rel(2), -10000, 10000, tall, box)).toMatchObject({ u: 1, v: 0 });
    expect(panInCell(rel(2), 10000, -10000, tall, box)).toMatchObject({ u: 0, v: 1 });
  });
});

describe("actualSizeViewport / fitAllViewport", () => {
  it("actualSize 是 px s=1，保留 u,v", () => {
    expect(actualSizeViewport(rel(3, 0.2, 0.8))).toEqual(px(1, 0.2, 0.8));
  });

  it("fitAll 是 FIT_VIEWPORT", () => {
    expect(fitAllViewport()).toEqual(FIT_VIEWPORT);
    expect(FIT_VIEWPORT).toEqual(rel(1));
  });
});

describe("isZoomed", () => {
  it("图在任一方向大于格子才算放大", () => {
    expect(isZoomed(FIT_VIEWPORT, tall, box)).toBe(false);
    expect(isZoomed(rel(2), tall, box)).toBe(true);
    expect(isZoomed(px(1), small, box)).toBe(false);
    expect(isZoomed(px(2.5), small, box)).toBe(true);
  });
});
