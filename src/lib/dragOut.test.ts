import { expect, it } from "vitest";
import { isLeavingWindow, isOutsideWindow } from "./dragOut";

const vp = { width: 1000, height: 800 };
it("窗口中间不算离开", () => {
  expect(isLeavingWindow({ x: 500, y: 400 }, vp)).toBe(false);
});
it("贴近任一边缘算离开", () => {
  for (const p of [{ x: 3, y: 400 }, { x: 997, y: 400 }, { x: 500, y: 3 }, { x: 500, y: 797 }]) {
    expect(isLeavingWindow(p, vp)).toBe(true);
  }
});
it("已在窗口外也算离开", () => {
  expect(isLeavingWindow({ x: -20, y: 400 }, vp)).toBe(true);
});
it("贴着边缘但仍在视口内不算在窗口外", () => {
  for (const p of [{ x: 0, y: 400 }, { x: 999, y: 400 }, { x: 500, y: 0 }, { x: 500, y: 799 }, { x: 3, y: 3 }]) {
    expect(isOutsideWindow(p, vp)).toBe(false);
  }
});
it("越过任一边界算在窗口外", () => {
  for (const p of [{ x: -1, y: 400 }, { x: 1000, y: 400 }, { x: 500, y: -1 }, { x: 500, y: 800 }]) {
    expect(isOutsideWindow(p, vp)).toBe(true);
  }
});
