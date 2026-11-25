// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allCommands } from "./commands";
import { registerBasketCommands } from "./basketCommands";
import { handleKeyDown } from "./useKeyboard";
import { useBasket } from "../stores/basket";
import { useCatalog } from "../stores/catalog";
import { topView, useNav } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { selectOnly, toggle } from "../lib/selection";

vi.mock("../ipc/api");

let off = () => {};
const press = (key: string, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: target });
  handleKeyDown(e);
  return e;
};

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  useBasket.setState({ order: [], items: new Map(), missing: new Set() });
  useSelection.getState().clear();
  const c = useCatalog.getState();
  c.begin({ generation: 1, path: "/r", name: "r", recursive: false, focus: null });
  c.apply({
    type: "batch", generation: 1,
    entries: [1, 2, 3].map((i) => ({ id: i, relPath: `${i}.png`, size: 1, mtimeMs: 1 })),
  });
  off = registerBasketCommands();
});
afterEach(() => off());

describe("basketCommands", () => {
  it("网格选中 a、b 时空格两次：先加入后移出，且拦下默认滚动", () => {
    useSelection.getState().set(toggle(selectOnly(2), 1));
    expect(press(" ").defaultPrevented).toBe(true);
    expect(useBasket.getState().order).toEqual([1, 2]);
    press(" ");
    expect(useBasket.getState().order).toEqual([]);
  });

  it("无选中时作用于焦点；都没有则不做事", () => {
    press(" ");
    expect(useBasket.getState().order).toEqual([]);
    useSelection.setState({ focus: 3 });
    press(" ");
    expect(useBasket.getState().order).toEqual([3]);
  });

  it("单张视图里空格作用于当前图", () => {
    useNav.getState().openSingle(2);
    press(" ");
    expect(useBasket.getState().order).toEqual([2]);
  });

  it("输入框聚焦时空格不触发", () => {
    useSelection.getState().set(selectOnly(1));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(" ", input);
    expect(useBasket.getState().order).toEqual([]);
    input.remove();
  });

  it("篮空时 C 不匹配；有图时进入对比", () => {
    expect(press("c").defaultPrevented).toBe(false);
    expect(topView().kind).toBe("grid");
    useBasket.getState().toggle([1]);
    press("c");
    expect(topView().kind).toBe("compare");
  });

  it("命令归在“对比”分类", () => {
    const cats = allCommands().filter((c) => c.id.startsWith("basket.")).map((c) => c.category);
    expect(cats).toEqual(["cmd.cat.compare", "cmd.cat.compare"]);
  });
});
