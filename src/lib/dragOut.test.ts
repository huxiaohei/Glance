import { expect, it } from "vitest";
import { isLeavingWindow } from "./dragOut";

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
