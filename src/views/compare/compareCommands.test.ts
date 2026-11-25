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

  it("缺失的焦点格按 Enter 不打开", () => {
    useBasket.setState({ missing: new Set([5]) });
    useCompareUi.setState({ focus: 5 });
    press("Enter");
    expect(topView().kind).toBe("compare");
  });
});
