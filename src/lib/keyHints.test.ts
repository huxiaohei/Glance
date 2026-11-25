import { describe, expect, it } from "vitest";
import { compareHints, gridHints, singleHints } from "./keyHints";

describe("gridHints", () => {
  it("没有选中、篮空：没有提示", () => {
    expect(gridHints({ selected: 0, selectedNotInBasket: 0, basket: 0 })).toEqual([]);
  });

  it("没有选中、篮里有图：只提示进入对比", () => {
    expect(gridHints({ selected: 0, selectedNotInBasket: 0, basket: 3 })).toEqual([{ id: "compare.open", n: 3 }]);
  });

  it("选中一张且不在篮里、篮空：加入对比与放大查看", () => {
    expect(gridHints({ selected: 1, selectedNotInBasket: 1, basket: 0 })).toEqual([
      { id: "basket.add", n: 1 },
      { id: "grid.open" },
    ]);
  });

  it("选中多张、部分不在篮里、篮里有图：加入未在篮里的张数，再进入对比，不提示放大查看", () => {
    expect(gridHints({ selected: 4, selectedNotInBasket: 2, basket: 5 })).toEqual([
      { id: "basket.add", n: 2 },
      { id: "compare.open", n: 5 },
    ]);
  });

  it("选中一张、不在篮里、篮里有图：三条，按可能性排序", () => {
    expect(gridHints({ selected: 1, selectedNotInBasket: 1, basket: 2 })).toEqual([
      { id: "basket.add", n: 1 },
      { id: "compare.open", n: 2 },
      { id: "grid.open" },
    ]);
  });

  it("选中的全在篮里：移出对比（选中张数）、进入对比、单张时放大查看", () => {
    expect(gridHints({ selected: 1, selectedNotInBasket: 0, basket: 3 })).toEqual([
      { id: "basket.remove", n: 1 },
      { id: "compare.open", n: 3 },
      { id: "grid.open" },
    ]);
    expect(gridHints({ selected: 2, selectedNotInBasket: 0, basket: 3 })).toEqual([
      { id: "basket.remove", n: 2 },
      { id: "compare.open", n: 3 },
    ]);
  });

  it("最多三条", () => {
    for (const s of [0, 1, 2, 5])
      for (const nb of [0, 1, s])
        for (const b of [0, 1, 9]) expect(gridHints({ selected: s, selectedNotInBasket: Math.min(nb, s), basket: b }).length).toBeLessThanOrEqual(3);
  });
});

describe("singleHints", () => {
  it("当前不在篮里、篮空：加入对比与切换", () => {
    expect(singleHints({ currentInBasket: false, basket: 0 })).toEqual([{ id: "basket.add" }, { id: "single.switch" }]);
  });

  it("当前在篮里：移出对比、进入对比（篮内张数）、切换", () => {
    expect(singleHints({ currentInBasket: true, basket: 2 })).toEqual([
      { id: "basket.remove" },
      { id: "compare.open", n: 2 },
      { id: "single.switch" },
    ]);
  });

  it("当前不在篮里、篮里有图：加入对比、进入对比、切换", () => {
    expect(singleHints({ currentInBasket: false, basket: 4 })).toEqual([
      { id: "basket.add" },
      { id: "compare.open", n: 4 },
      { id: "single.switch" },
    ]);
  });
});

describe("compareHints", () => {
  it("未放大：同步缩放、同步开关、移出", () => {
    expect(compareHints({ zoomed: false })).toEqual([
      { id: "compare.zoom" },
      { id: "compare.sync" },
      { id: "compare.remove" },
    ]);
  });

  it("已放大：同步缩放、平移、同步开关（截到三条，去掉移出）", () => {
    expect(compareHints({ zoomed: true })).toEqual([{ id: "compare.zoom" }, { id: "compare.pan" }, { id: "compare.sync" }]);
  });
});
