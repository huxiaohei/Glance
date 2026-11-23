import { describe, expect, it } from "vitest";
import { accumulateWheel } from "./wheelZoom";

describe("accumulateWheel", () => {
  it("鼠标滚轮一格（100）恰好一步；向上滚为放大", () => {
    expect(accumulateWheel(0, -100, 0)).toEqual({ acc: 0, steps: 1 });
    expect(accumulateWheel(0, 100, 0)).toEqual({ acc: 0, steps: -1 });
  });

  it("触控板小增量累积，凑满 100 才走一步", () => {
    let acc = 0, total = 0;
    for (let i = 0; i < 10; i++) {
      const r = accumulateWheel(acc, -10, 0);
      acc = r.acc;
      total += r.steps;
      if (i < 9) expect(r.steps).toBe(0);
    }
    expect(total).toBe(1);
    expect(acc).toBeCloseTo(0);
  });

  it("行模式的增量按 100 倍折算", () => {
    expect(accumulateWheel(0, -1, 1)).toEqual({ acc: 0, steps: 1 });
    expect(accumulateWheel(0, 2, 1)).toEqual({ acc: 0, steps: -2 });
  });

  it("余量保留到下一次，方向反转时互相抵消", () => {
    const a = accumulateWheel(0, -60, 0);
    expect(a).toEqual({ acc: -60, steps: 0 });
    const b = accumulateWheel(a.acc, 30, 0);
    expect(b).toEqual({ acc: -30, steps: 0 });
    expect(accumulateWheel(b.acc, -170, 0)).toEqual({ acc: 0, steps: 2 });
  });
});
