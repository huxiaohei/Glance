import { describe, expect, it } from "vitest";
import { createWheelStepper } from "./wheelStep";

describe("createWheelStepper", () => {
  it("累计到阈值才切换：20、20、20 → 0、0、1", () => {
    const step = createWheelStepper();
    expect([step(20, 0), step(20, 10), step(20, 20)]).toEqual([0, 0, 1]);
  });

  it("一次大滚动立即切换：100 → 1", () => {
    expect(createWheelStepper()(100, 0)).toBe(1);
  });

  it("间隔内的事件被丢弃：t=0 时 100 → 1；t=50 时 100 → 0；t=200 时 100 → 1", () => {
    const step = createWheelStepper();
    expect([step(100, 0), step(100, 50), step(100, 200)]).toEqual([1, 0, 1]);
  });

  it("间隔内丢弃的事件不留累计：t=0 时 100 → 1；t=50 时 59 → 0；t=200 时 1 → 0", () => {
    const step = createWheelStepper();
    expect([step(100, 0), step(59, 50), step(1, 200)]).toEqual([1, 0, 0]);
  });

  it("向上滚返回 -1", () => {
    expect(createWheelStepper()(-100, 0)).toBe(-1);
  });

  it("方向改变时累计清零：30、-30 → 0、0；再 -30 → -1", () => {
    const step = createWheelStepper();
    expect([step(30, 0), step(-30, 10)]).toEqual([0, 0]);
    expect(step(-30, 20)).toBe(-1);
  });

  it("阈值与间隔可配置", () => {
    const step = createWheelStepper({ threshold: 10, cooldownMs: 1000 });
    expect([step(10, 0), step(10, 500), step(10, 1000)]).toEqual([1, 0, 1]);
  });
});
