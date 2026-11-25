// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCommand } from "../../app/commands";
import { setLanguage } from "../../i18n";
import type { FileId } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { FIT_VIEWPORT } from "../../lib/compareViewport";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi } from "../../stores/compareUi";
import { topView, useNav } from "../../stores/nav";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useToast } from "../../stores/toast";
import { registerCompareCommands } from "./compareCommands";

const item = (id: FileId): BasketItem => ({ id, name: `${id}.png`, dirName: "蜀", size: 1, mtimeMs: 1, width: 1024, height: 1536 });

function fill(n: number) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  useBasket.setState({ order: ids, items: new Map(ids.map((id) => [id, item(id)])), missing: new Set() });
}

let off = () => {};
beforeEach(() => {
  setLanguage("zh-CN");
  off = registerCompareCommands();
  useCatalog.getState().reset();
  useNav.getState().reset();
  useNav.getState().openCompare();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, compareColumns: 4 }, open: false });
  useToast.setState({ current: null });
  useCompareUi.setState({ viewport: FIT_VIEWPORT, perCell: null, focus: 1, captions: true });
  fill(10);
});
afterEach(() => off());

const key = (k: string, code = k) => ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
const esc = key("Escape");
function press(k: string, code = k) {
  const cmd = findCommand(key(k, code), "compare", false, true);
  expect(cmd, `命令 ${k}`).not.toBeNull();
  cmd!.run({ shift: false, repeat: false });
  return cmd!;
}

describe("对比视图命令", () => {
  it("Esc 在对比视图里返回进入前的视图", () => {
    const cmd = findCommand(esc, "compare", false, true);
    expect(cmd?.id).toBe("compare.back");
    cmd!.run({ shift: false, repeat: false });
    expect(topView().kind).toBe("grid");
  });

  it("按住 Esc 的自动重复不返回", () => {
    findCommand(esc, "compare", false, true)!.run({ shift: false, repeat: true });
    expect(topView().kind).toBe("compare");
  });

  it("只在对比视图里生效", () => {
    expect(findCommand(esc, "grid", false, true)?.id).not.toBe("compare.back");
  });

  it("4 列 10 张：焦点在第 2 张按 ↓ 到第 6 张；第 9 张按 ↓ 不动", () => {
    useCompareUi.setState({ focus: 2 });
    expect(press("ArrowDown").id).toBe("compare.focusDown");
    expect(useCompareUi.getState().focus).toBe(6);
    useCompareUi.setState({ focus: 9 });
    press("ArrowDown");
    expect(useCompareUi.getState().focus).toBe(9);
  });

  it("← → ↑ 按 1 / 列数移动，到边不动", () => {
    useCompareUi.setState({ focus: 1 });
    press("ArrowLeft");
    expect(useCompareUi.getState().focus).toBe(1);
    press("ArrowRight");
    expect(useCompareUi.getState().focus).toBe(2);
    press("ArrowUp");
    expect(useCompareUi.getState().focus).toBe(2);
    useCompareUi.setState({ focus: 10 });
    press("ArrowRight");
    expect(useCompareUi.getState().focus).toBe(10);
    press("ArrowUp");
    expect(useCompareUi.getState().focus).toBe(6);
  });

  it("Delete 移出焦点格，提示条带撤销；撤销后回到原位置", () => {
    useCompareUi.setState({ focus: 3 });
    expect(press("Delete").id).toBe("compare.remove");
    expect(useBasket.getState().order).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
    // 焦点落到补位的那一张
    expect(useCompareUi.getState().focus).toBe(4);
    const toast = useToast.getState().current!;
    expect(toast.text).toBe("已移出对比");
    const undo = toast.actions!.find((a) => a.label === "撤销")!;
    undo.run();
    expect(useBasket.getState().order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(useBasket.getState().items.has(3)).toBe(true);
  });

  it("Backspace 同样移出", () => {
    useCompareUi.setState({ focus: 10 });
    press("Backspace");
    expect(useBasket.getState().order).toHaveLength(9);
    expect(useCompareUi.getState().focus).toBe(9);
  });

  it("最后一张移出后回到进入前的视图，撤销恢复篮子但不重新进入对比", () => {
    fill(1);
    useCompareUi.setState({ focus: 1 });
    press("Delete");
    expect(useBasket.getState().order).toEqual([]);
    expect(topView().kind).toBe("grid");
    expect(useToast.getState().current!.text).toBe("已移出对比");
    useToast.getState().current!.actions![0].run();
    expect(useBasket.getState().order).toEqual([1]);
    expect(topView().kind).toBe("grid");
  });

  it("S 切换同步：perCell 非 null", () => {
    expect(press("s", "KeyS").id).toBe("compare.toggleSync");
    expect(useCompareUi.getState().perCell).not.toBeNull();
    press("s", "KeyS");
    expect(useCompareUi.getState().perCell).toBeNull();
  });

  it("1 → 逐像素；0 → 回到适应", () => {
    expect(press("1", "Digit1").id).toBe("compare.actual");
    expect(useCompareUi.getState().viewport.scale.kind).toBe("px");
    expect(press("0", "Digit0").id).toBe("compare.fit");
    expect(useCompareUi.getState().viewport).toEqual(FIT_VIEWPORT);
  });

  it("同步关时 1 只改焦点格", () => {
    useCompareUi.setState({ perCell: new Map(), focus: 2 });
    press("1", "Digit1");
    const s = useCompareUi.getState();
    expect(s.viewport).toEqual(FIT_VIEWPORT);
    expect(s.perCell!.get(2)!.scale.kind).toBe("px");
  });

  it("Enter 打开焦点格：栈顶为 basket 来源的单张", () => {
    useCompareUi.setState({ focus: 5 });
    expect(press("Enter").id).toBe("compare.open");
    expect(topView()).toEqual({ kind: "single", source: "basket", id: 5 });
  });

  it("键盘焦点在按钮（顶栏按钮、格上的移出按钮）上时 Enter 不当打开，留给按钮自己", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    try {
      btn.focus();
      expect(findCommand(key("Enter"), "compare", false, true)).toBeNull();
      btn.blur();
      expect(findCommand(key("Enter"), "compare", false, true)?.id).toBe("compare.open");
    } finally {
      btn.remove();
    }
  });

  it("缺失的焦点格按 Enter 不打开", () => {
    useBasket.setState({ missing: new Set([5]) });
    useCompareUi.setState({ focus: 5 });
    press("Enter");
    expect(topView().kind).toBe("compare");
  });

  describe("Alt+方向键交换", () => {
    const alt = (k: string) => ({ ...key(k), altKey: true });
    function pressAlt(k: string) {
      const cmd = findCommand(alt(k), "compare", false, true);
      expect(cmd, `命令 Alt+${k}`).not.toBeNull();
      cmd!.run({ shift: false, repeat: false });
      return cmd!;
    }

    it("四个方向与相邻格交换，焦点仍是原图", () => {
      useCompareUi.setState({ focus: 6 });
      expect(pressAlt("ArrowLeft").id).toBe("compare.moveLeft");
      expect(useBasket.getState().order.slice(3, 6)).toEqual([4, 6, 5]);
      expect(useCompareUi.getState().focus).toBe(6);
      expect(pressAlt("ArrowRight").id).toBe("compare.moveRight");
      expect(useBasket.getState().order.slice(3, 6)).toEqual([4, 5, 6]);
      expect(pressAlt("ArrowUp").id).toBe("compare.moveUp");
      expect(useBasket.getState().order.slice(0, 6)).toEqual([1, 6, 3, 4, 5, 2]);
      expect(pressAlt("ArrowDown").id).toBe("compare.moveDown");
      expect(useBasket.getState().order.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(useCompareUi.getState().focus).toBe(6);
    });

    it("越界不动", () => {
      useCompareUi.setState({ focus: 1 });
      pressAlt("ArrowLeft");
      pressAlt("ArrowUp");
      useCompareUi.setState({ focus: 10 });
      pressAlt("ArrowRight");
      pressAlt("ArrowDown");
      expect(useBasket.getState().order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("普通方向键只移动焦点，不交换", () => {
      useCompareUi.setState({ focus: 2 });
      expect(press("ArrowRight").id).toBe("compare.focusRight");
      expect(useCompareUi.getState().focus).toBe(3);
      expect(useBasket.getState().order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });
});

describe("添加面板的键盘（按焦点区域分派）", () => {
  // 面板来源：当前文件夹里的 7 张（id 101..107，按文件名排序）
  function openRoot() {
    useCatalog.getState().begin({ generation: 1, path: "/三国", name: "三国", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: Array.from({ length: 7 }, (_, i) => ({ id: 101 + i, relPath: `p${i + 1}.png`, size: 10, mtimeMs: 5 })),
    });
    useCatalog.getState().apply({ type: "done", generation: 1, total: 7 });
  }
  const tab = key("Tab");
  const ui = () => useCompareUi.getState();

  beforeEach(() => {
    openRoot();
    // 打开目录会把视图栈放回网格
    useNav.getState().reset();
    useNav.getState().openCompare();
    useCompareUi.setState({ panelOpen: false, panelSource: { kind: "root" }, focusArea: "wall", panelFocus: null });
  });

  it("Tab 打开面板并把焦点放进面板（第一张）；再按 Tab 收起，焦点回墙", () => {
    expect(press("Tab").id).toBe("compare.togglePanel");
    expect(ui().panelOpen).toBe(true);
    expect(ui().focusArea).toBe("panel");
    expect(ui().panelFocus).toBe(101);
    press("Tab");
    expect(ui().panelOpen).toBe(false);
    expect(ui().focusArea).toBe("wall");
    expect(findCommand(tab, "grid", false, true)?.id).not.toBe("compare.togglePanel");
  });

  it("面板已开但焦点在墙（顶栏按钮打开）：Tab 把焦点移进面板，不收起；再按 Tab 才收起", () => {
    ui().togglePanel();
    expect(ui().focusArea).toBe("wall");
    press("Tab");
    expect(ui().panelOpen).toBe(true);
    expect(ui().focusArea).toBe("panel");
    expect(ui().panelFocus).toBe(101);
    press("Tab");
    expect(ui().panelOpen).toBe(false);
    expect(ui().focusArea).toBe("wall");
  });

  it("Tab 再打开时落在上次的位置；上次那张已不在面板里时落第一张", () => {
    press("Tab");
    press("ArrowRight");
    press("ArrowRight");
    press("Tab");
    press("Tab");
    expect(ui().panelFocus).toBe(103);
    press("Tab");
    useCompareUi.setState({ panelFocus: 999 });
    press("Tab");
    expect(ui().panelFocus).toBe(101);
  });

  it("面板区方向键移动面板焦点：左右 ±1、上下 ±3，到边不动；墙的焦点不变", () => {
    press("Tab");
    press("ArrowLeft");
    expect(ui().panelFocus).toBe(101);
    press("ArrowUp");
    expect(ui().panelFocus).toBe(101);
    press("ArrowDown");
    expect(ui().panelFocus).toBe(104);
    press("ArrowDown");
    expect(ui().panelFocus).toBe(107);
    press("ArrowDown");
    press("ArrowRight");
    expect(ui().panelFocus).toBe(107);
    press("ArrowUp");
    expect(ui().panelFocus).toBe(104);
    press("ArrowLeft");
    expect(ui().panelFocus).toBe(103);
    expect(ui().focus).toBe(1);
  });

  it("空格只在面板区响应：切换面板焦点那张的加入状态", () => {
    fill(2);
    expect(findCommand(key(" ", "Space"), "compare", false, true)).toBeNull();
    press("Tab");
    press("ArrowRight");
    expect(press(" ", "Space").id).toBe("compare.panelToggle");
    expect(useBasket.getState().order).toEqual([1, 2, 102]);
    press(" ", "Space");
    expect(useBasket.getState().order).toEqual([1, 2]);
  });

  it("面板区 Enter 等同空格，不打开单张", () => {
    fill(2);
    press("Tab");
    press("Enter");
    expect(useBasket.getState().order).toEqual([1, 2, 101]);
    expect(topView().kind).toBe("compare");
  });

  it("Esc 两段式：面板区只把焦点还给墙（面板仍开），墙上才返回", () => {
    press("Tab");
    press("Escape");
    expect(ui().focusArea).toBe("wall");
    expect(ui().panelOpen).toBe(true);
    expect(topView().kind).toBe("compare");
    press("Escape");
    expect(topView().kind).toBe("grid");
  });

  it("面板区 Delete、缩放、0、1、S、Alt+方向键不响应", () => {
    useCompareUi.setState({ focus: 2 });
    press("Tab");
    const before = useBasket.getState().order;
    press("Delete");
    press("Backspace");
    press("+", "Equal");
    press("-", "Minus");
    press("1", "Digit1");
    press("0", "Digit0");
    press("s", "KeyS");
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      findCommand({ ...key(k), altKey: true }, "compare", false, true)?.run({ shift: false, repeat: false });
    }
    expect(useBasket.getState().order).toBe(before);
    expect(ui().viewport).toEqual(FIT_VIEWPORT);
    expect(ui().perCell).toBeNull();
    expect(useToast.getState().current).toBeNull();
  });

  it("新的进入把焦点区域放回墙；顶栏按钮收起面板也回墙", () => {
    press("Tab");
    ui().enter(true, 1);
    expect(ui().focusArea).toBe("wall");
    useCompareUi.setState({ focusArea: "panel" });
    ui().togglePanel();
    expect(ui().panelOpen).toBe(false);
    expect(ui().focusArea).toBe("wall");
  });
});
