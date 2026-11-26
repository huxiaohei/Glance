import { describe, expect, it } from "vitest";
import type { CropState } from "../ipc/types";
import {
  cssTransform, dragRect, fitRatio, flip, orientedSize, ratioOf, resizeTo, rotate, type Rect,
} from "./cropGeometry";

const b = { w: 400, h: 300 };
const full: Rect = { x: 0, y: 0, w: 400, h: 300 };
const st = (rect: Rect, quarterTurns: 0 | 1 | 2 | 3 = 0, flipH = false, flipV = false): CropState => ({ rect, quarterTurns, flipH, flipV });

function inside(r: Rect, bd: { w: number; h: number }) {
  expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true);
  expect(r.w).toBeGreaterThanOrEqual(1);
  expect(r.h).toBeGreaterThanOrEqual(1);
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(bd.w);
  expect(r.y + r.h).toBeLessThanOrEqual(bd.h);
}

describe("orientedSize / ratioOf", () => {
  it("奇数次转宽高互换", () => {
    expect(orientedSize(400, 300, 0)).toEqual({ w: 400, h: 300 });
    expect(orientedSize(400, 300, 1)).toEqual({ w: 300, h: 400 });
    expect(orientedSize(400, 300, 2)).toEqual({ w: 400, h: 300 });
    expect(orientedSize(400, 300, 3)).toEqual({ w: 300, h: 400 });
  });
  it("比例换算", () => {
    const m = { ratio: "free" as const, customW: 5, customH: 2, portrait: false };
    expect(ratioOf(m)).toBeNull();
    expect(ratioOf({ ...m, ratio: "1:1", portrait: true })).toBe(1);
    expect(ratioOf({ ...m, ratio: "4:3" })).toBeCloseTo(4 / 3);
    expect(ratioOf({ ...m, ratio: "4:3", portrait: true })).toBeCloseTo(3 / 4);
    expect(ratioOf({ ...m, ratio: "16:9" })).toBeCloseTo(16 / 9);
    expect(ratioOf({ ...m, ratio: "16:9", portrait: true })).toBeCloseTo(9 / 16);
    expect(ratioOf({ ...m, ratio: "custom" })).toBeCloseTo(2.5);
    expect(ratioOf({ ...m, ratio: "custom", portrait: true })).toBeCloseTo(0.4);
  });
});

describe("dragRect", () => {
  it("自由拖角", () => {
    expect(dragRect(full, "se", -100, -50, b, null)).toEqual({ x: 0, y: 0, w: 300, h: 250 });
    expect(dragRect({ x: 100, y: 100, w: 100, h: 100 }, "nw", 30, 20, b, null)).toEqual({ x: 130, y: 120, w: 70, h: 80 });
  });
  it("移动不能出界", () => {
    const r = { x: 10, y: 10, w: 100, h: 50 };
    expect(dragRect(r, "move", 1000, 0, b, null)).toEqual({ x: 300, y: 10, w: 100, h: 50 });
    expect(dragRect(r, "move", -1000, -1000, b, null)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
  it("最小 1x1，且不越界", () => {
    expect(dragRect(full, "e", -1000, 0, b, null).w).toBe(1);
    expect(dragRect(full, "w", 1000, 0, b, null)).toEqual({ x: 399, y: 0, w: 1, h: 300 });
    expect(dragRect(full, "se", 1000, 1000, b, null)).toEqual(full);
    expect(dragRect(full, "nw", -1000, -1000, b, null)).toEqual(full);
  });
  it("锁比例", () => {
    expect(dragRect({ x: 0, y: 0, w: 300, h: 300 }, "se", -100, 0, b, 1)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    // 碰边：两边按比例一起停
    expect(dragRect({ x: 0, y: 0, w: 100, h: 100 }, "se", 1000, 1000, b, 1)).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    // 边把手：另一边绕中心跟随
    expect(dragRect({ x: 100, y: 100, w: 100, h: 100 }, "e", 100, 0, b, 1)).toEqual({ x: 100, y: 50, w: 200, h: 200 });
  });
  it("随机拖动恒在界内", () => {
    const handles = ["n", "s", "e", "w", "ne", "nw", "se", "sw", "move"] as const;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 400; i++) {
      const start = { x: Math.floor(rnd() * 200), y: Math.floor(rnd() * 150), w: 1 + Math.floor(rnd() * 150), h: 1 + Math.floor(rnd() * 100) };
      const ratio = [null, 1, 4 / 3, 9 / 16][i % 4];
      const r = dragRect(start, handles[i % 9], Math.round(rnd() * 800 - 400), Math.round(rnd() * 800 - 400), b, ratio);
      inside(r, b);
    }
  });
});

describe("fitRatio / resizeTo", () => {
  it("fitRatio 以中心为准取最大框", () => {
    expect(fitRatio(full, 1, b)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    // 取整规则：位置 Math.round，37.5 进为 38
    expect(fitRatio(full, 16 / 9, b)).toEqual({ x: 0, y: 38, w: 400, h: 225 });
  });
  it("resizeTo 保持中心", () => {
    expect(resizeTo(full, 200, null, 4 / 3, b)).toEqual({ x: 100, y: 75, w: 200, h: 150 });
    expect(resizeTo(full, null, 150, 4 / 3, b)).toEqual({ x: 100, y: 75, w: 200, h: 150 });
    expect(resizeTo({ x: 100, y: 100, w: 100, h: 100 }, 50, null, null, b)).toEqual({ x: 125, y: 100, w: 50, h: 100 });
  });
  it("resizeTo 超出夹到 bounds", () => {
    expect(resizeTo(full, 5000, null, null, b)).toEqual(full);
    expect(resizeTo(full, 5000, null, 1, b)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    inside(resizeTo({ x: 300, y: 200, w: 100, h: 100 }, 380, null, null, b), b);
  });
});

describe("rotate / flip", () => {
  const s0 = st({ x: 10, y: 20, w: 100, h: 50 });
  const dims = { w: 400, h: 300 };
  it("右转与左转", () => {
    const r = rotate(s0, 1, dims);
    expect(r).toEqual(st({ x: 230, y: 10, w: 50, h: 100 }, 1));
    expect(rotate(r, -1, dims)).toEqual(s0);
    expect(rotate(s0, -1, dims).quarterTurns).toBe(3);
  });
  it("仅一个翻转时旋转互换 flipH 与 flipV", () => {
    expect(rotate(st(s0.rect, 0, true, false), 1, dims)).toMatchObject({ flipH: false, flipV: true });
    expect(rotate(st(s0.rect, 0, false, true), -1, dims)).toMatchObject({ flipH: true, flipV: false });
    expect(rotate(st(s0.rect, 0, true, true), 1, dims)).toMatchObject({ flipH: true, flipV: true });
  });
  it("翻转", () => {
    expect(flip(s0, "h", dims)).toEqual(st({ x: 290, y: 20, w: 100, h: 50 }, 0, true, false));
    expect(flip(s0, "v", dims)).toEqual(st({ x: 10, y: 230, w: 100, h: 50 }, 0, false, true));
    expect(flip(flip(s0, "h", dims), "h", dims)).toEqual(s0);
    // 转 90° 后水平翻转用的是转后宽度 300
    expect(flip(rotate(s0, 1, dims), "h", dims).rect).toEqual({ x: 20, y: 10, w: 50, h: 100 });
  });
  it("极小图都在界内", () => {
    for (const d of [{ w: 1, h: 1 }, { w: 2, h: 3 }]) {
      let s = st({ x: 0, y: 0, w: d.w, h: d.h });
      for (let i = 0; i < 9; i++) {
        s = i % 3 === 2 ? flip(s, i % 2 ? "h" : "v", d) : rotate(s, i % 2 ? 1 : -1, d);
        inside(s.rect, orientedSize(d.w, d.h, s.quarterTurns));
      }
      const o = orientedSize(d.w, d.h, s.quarterTurns);
      inside(dragRect(s.rect, "se", 50, 50, o, null), o);
      inside(dragRect(s.rect, "nw", -50, 50, o, 1), o);
      inside(fitRatio(s.rect, 16 / 9, o), o);
      inside(fitRatio(s.rect, 9 / 16, o), o);
      inside(resizeTo(s.rect, 1, null, 4 / 3, o), o);
    }
  });
});

describe("cssTransform 与后端语义一致", () => {
  // 后端：顺时针 turns 次 (x,y)->(H-1-y,x)，再在转后画面里翻转
  function backend(p: [number, number], s: CropState, W: number, H: number): [number, number] {
    let [x, y] = p; let w = W; let h = H;
    for (let i = 0; i < s.quarterTurns; i++) { [x, y] = [h - 1 - y, x]; [w, h] = [h, w]; }
    if (s.flipH) x = w - 1 - x;
    if (s.flipV) y = h - 1 - y;
    return [x, y];
  }
  // CSS：scale(sx,sy) rotate(θ)，绕中心，右往左作用；y 向下，rotate 正向为顺时针
  function css(p: [number, number], s: CropState, W: number, H: number): [number, number] {
    const m = /scale\((-?1), (-?1)\) rotate\((\d+)deg\)/.exec(cssTransform(s))!;
    const sx = Number(m[1]); const sy = Number(m[2]); const th = (Number(m[3]) * Math.PI) / 180;
    const dx = p[0] - (W - 1) / 2; const dy = p[1] - (H - 1) / 2;
    const rx = dx * Math.cos(th) - dy * Math.sin(th);
    const ry = dx * Math.sin(th) + dy * Math.cos(th);
    const o = orientedSize(W, H, s.quarterTurns);
    return [Math.round(sx * rx + (o.w - 1) / 2) + 0, Math.round(sy * ry + (o.h - 1) / 2) + 0];
  }
  it("字符串形式", () => {
    expect(cssTransform(st(full, 3, true, false))).toBe("scale(-1, 1) rotate(270deg)");
  });
  it("随机 12 步序列", () => {
    const W = 2; const H = 3;
    const dims = { w: W, h: H };
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 50; trial++) {
      let s = st({ x: 0, y: 0, w: W, h: H });
      for (let i = 0; i < 12; i++) {
        const k = Math.floor(rnd() * 4);
        s = k === 0 ? rotate(s, 1, dims) : k === 1 ? rotate(s, -1, dims) : flip(s, k === 2 ? "h" : "v", dims);
        for (const c of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]] as [number, number][]) {
          expect(css(c, s, W, H)).toEqual(backend(c, s, W, H));
        }
      }
    }
  });
  it("rect 跟着内容：整图框的四角经同一变换后仍是整图", () => {
    const dims = { w: 2, h: 3 };
    let s = st({ x: 0, y: 0, w: 2, h: 3 });
    s = flip(rotate(flip(s, "v", dims), 1, dims), "h", dims);
    const o = orientedSize(2, 3, s.quarterTurns);
    expect(s.rect).toEqual({ x: 0, y: 0, w: o.w, h: o.h });
  });
});
