import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  actualSize,
  clampViewport,
  fitScale,
  fitViewport,
  minScale,
  panBy,
  resizeViewport,
  toggleFit,
  wheelFactor,
  zoomAt,
  type Size,
  type Viewport,
} from "./viewport";

const box: Size = { w: 1000, h: 800 };
const big: Size = { w: 4000, h: 3000 };

function finite(v: Viewport) {
  return [v.scale, v.x, v.y].every(Number.isFinite);
}

describe("viewport", () => {
  it("fitScale：大图缩小到完整显示，小图不放大", () => {
    expect(fitScale({ w: 4000, h: 2000 }, { w: 1000, h: 800 })).toBeCloseTo(0.25);
    expect(fitScale({ w: 100, h: 50 }, { w: 1000, h: 800 })).toBe(1);
    expect(fitScale({ w: 0, h: 50 }, box)).toBe(1);
    expect(fitScale({ w: 100, h: 50 }, { w: 0, h: 800 })).toBe(1);
  });

  it("minScale 取适应倍率与 0.1 的较小者", () => {
    expect(minScale(big, box)).toBeCloseTo(0.1);
    expect(minScale({ w: 20000, h: 100 }, box)).toBeCloseTo(0.05);
    expect(minScale({ w: 100, h: 50 }, box)).toBeCloseTo(0.1);
  });

  it("fitViewport 居中", () => {
    const v = fitViewport({ w: 4000, h: 2000 }, box);
    expect(v.fit).toBe(true);
    expect(v.scale).toBeCloseTo(0.25);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo((800 - 500) / 2);
    const small = fitViewport({ w: 100, h: 50 }, box);
    expect(small.scale).toBe(1);
    expect(small.x).toBeCloseTo(450);
    expect(small.y).toBeCloseTo(375);
  });

  it("zoomAt 保持鼠标下的图片点不动（图片远大于容器）", () => {
    const img: Size = { w: 20000, h: 15000 };
    const v: Viewport = { scale: 1, x: -5000, y: -4000, fit: false };
    const px = 400;
    const py = 300;
    const before = { ix: (px - v.x) / v.scale, iy: (py - v.y) / v.scale };
    const r = zoomAt(v, 2, px, py, img, box);
    expect(r.scale).toBeCloseTo(2);
    expect((px - r.x) / r.scale).toBeCloseTo(before.ix);
    expect((py - r.y) / r.scale).toBeCloseTo(before.iy);
    expect(r.fit).toBe(false);
  });

  it("zoomAt 的结果仍会被夹住", () => {
    const v: Viewport = { scale: 1, x: 0, y: 0, fit: false };
    // 在容器右下角缩小，位置必须仍合法
    const r = zoomAt(v, 0.5, 1000, 800, big, box);
    expect(r.x).toBeLessThanOrEqual(0);
    expect(r.x).toBeGreaterThanOrEqual(box.w - big.w * r.scale - 1e-9);
    expect(r.y).toBeLessThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(box.h - big.h * r.scale - 1e-9);
  });

  it("zoomAt 夹在最小与最大倍率之间", () => {
    const v: Viewport = { scale: 1, x: 0, y: 0, fit: false };
    expect(zoomAt(v, 1e6, 500, 400, big, box).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, 1e-6, 500, 400, big, box).scale).toBeCloseTo(minScale(big, box));
  });

  it("zoomAt 的 factor 非法时按 1 处理", () => {
    const v: Viewport = { scale: 2, x: -100, y: -100, fit: false };
    for (const f of [NaN, Infinity, 0, -3]) {
      const r = zoomAt(v, f, 500, 400, big, box);
      expect(r.scale).toBeCloseTo(2);
      expect(finite(r)).toBe(true);
    }
  });

  it("zoomAt 回到适应倍率且图片不大于容器时 fit 为 true", () => {
    const fit = fitViewport(big, box);
    const zoomedIn = zoomAt(fit, 4, 500, 400, big, box);
    expect(zoomedIn.fit).toBe(false);
    const back = zoomAt(zoomedIn, fit.scale / zoomedIn.scale, 500, 400, big, box);
    expect(back.fit).toBe(true);
    expect(back.scale).toBeCloseTo(fit.scale);
  });

  it("图片不大于容器的方向上始终居中", () => {
    const img: Size = { w: 500, h: 4000 };
    const r = clampViewport({ scale: 1, x: 300, y: -900, fit: false }, img, box);
    expect(r.x).toBeCloseTo(250);
    expect(r.y).toBeCloseTo(-900);
  });

  it("平移不能拖出空边", () => {
    const v: Viewport = { scale: 1, x: 0, y: 0, fit: false };
    const a = panBy(v, 500, 500, big, box);
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(0);
    const b = panBy(v, -1e6, -1e6, big, box);
    expect(b.x).toBeCloseTo(box.w - big.w);
    expect(b.y).toBeCloseTo(box.h - big.h);
    expect(panBy(v, -100, -50, big, box)).toMatchObject({ x: -100, y: -50 });
  });

  it("actualSize 以指定点为中心设为 100%", () => {
    const fit = fitViewport(big, box);
    const px = 600;
    const py = 300;
    const ix = (px - fit.x) / fit.scale;
    const iy = (py - fit.y) / fit.scale;
    const r = actualSize(fit, px, py, big, box);
    expect(r.scale).toBe(1);
    expect(r.fit).toBe(false);
    expect((px - r.x) / r.scale).toBeCloseTo(ix);
    expect((py - r.y) / r.scale).toBeCloseTo(iy);
  });

  it("toggleFit 在适应与 100% 之间来回", () => {
    const fit = fitViewport(big, box);
    const full = toggleFit(fit, 500, 400, big, box);
    expect(full.scale).toBe(1);
    expect(full.fit).toBe(false);
    const back = toggleFit(full, 500, 400, big, box);
    expect(back).toEqual(fit);
  });

  it("toggleFit：适应倍率本来就是 1 时不变", () => {
    const img: Size = { w: 100, h: 50 };
    const fit = fitViewport(img, box);
    expect(toggleFit(fit, 10, 10, img, box)).toEqual(fit);
  });

  it("resizeViewport：适应状态下重新适应，已缩放时保持倍率", () => {
    const fit = fitViewport(big, box);
    const nb: Size = { w: 2000, h: 1500 };
    const r = resizeViewport(fit, big, nb);
    expect(r).toEqual(fitViewport(big, nb));
    const zoomed: Viewport = { scale: 2, x: -3000, y: -2000, fit: false };
    const r2 = resizeViewport(zoomed, big, nb);
    expect(r2.scale).toBe(2);
    expect(r2.fit).toBe(false);
    expect(r2.x).toBeGreaterThanOrEqual(nb.w - big.w * 2 - 1e-9);
    expect(r2.x).toBeLessThanOrEqual(0);
  });

  it("wheelFactor：滚轮与捏合的系数", () => {
    expect(wheelFactor(100, false)).toBeCloseTo(Math.exp(-0.15));
    expect(wheelFactor(-100, false)).toBeCloseTo(Math.exp(0.15));
    expect(wheelFactor(10, true)).toBeCloseTo(Math.exp(-0.1));
    expect(wheelFactor(0, false)).toBe(1);
    expect(wheelFactor(NaN, false)).toBe(1);
  });

  it.each([[1, 1], [8000, 8000], [20000, 50], [50, 20000]])(
    "极端尺寸 %i×%i 下结果都是有限数",
    (w, h) => {
      const img: Size = { w, h };
      const fit = fitViewport(img, box);
      const results = [
        fit,
        zoomAt(fit, 3, 10, 10, img, box),
        zoomAt(fit, 0.001, 990, 790, img, box),
        panBy(fit, -1e9, 1e9, img, box),
        actualSize(fit, 500, 400, img, box),
        toggleFit(fit, 500, 400, img, box),
        resizeViewport(fit, img, { w: 300, h: 200 }),
        clampViewport({ scale: 5, x: 1e9, y: -1e9, fit: false }, img, box),
      ];
      for (const r of results) expect(finite(r)).toBe(true);
    },
  );

  it("容器为 0×0 时不产生 NaN 或 Infinity", () => {
    const zero: Size = { w: 0, h: 0 };
    for (const img of [zero, big, { w: 0, h: 10 }]) {
      const fit = fitViewport(img, zero);
      const results = [
        fit,
        zoomAt(fit, 2, 0, 0, img, zero),
        panBy(fit, 10, 10, img, zero),
        actualSize(fit, 0, 0, img, zero),
        toggleFit(fit, 0, 0, img, zero),
        resizeViewport({ ...fit, fit: false }, img, zero),
        resizeViewport(fit, img, zero),
      ];
      for (const r of results) expect(finite(r)).toBe(true);
      expect(Number.isFinite(minScale(img, zero))).toBe(true);
    }
  });
});
