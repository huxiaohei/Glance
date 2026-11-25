// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalog } from "../../stores/catalog";
import { topView, useNav } from "../../stores/nav";
import { stopRename, useRename } from "../../stores/rename";
import { useSingleUi } from "../../stores/singleUi";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import TopBar from "./TopBar";

vi.mock("../../ipc/api");

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  stopRename();
  const c = useCatalog.getState();
  c.begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
  c.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "sub/赵云.png", size: 1, mtimeMs: 1 }] });
});

describe("TopBar 重命名", () => {
  it("对比篮来源时双击文件名不开始重命名", () => {
    useNav.getState().openCompare();
    useNav.getState().openSingle(1, "basket");
    const { container } = render(<TopBar id={1} />);
    fireEvent.doubleClick(container.querySelector(".topbar-name")!);
    expect(useRename.getState().id).toBeNull();
  });

  it("重命名期间文件名处是输入框；双击文件名开始重命名", () => {
    const { container } = render(<TopBar id={1} />);
    expect(container.querySelector("input")).toBeNull();
    fireEvent.doubleClick(container.querySelector(".topbar-name")!);
    expect(useRename.getState().id).toBe(1);
    const input = container.querySelector(".topbar-path input") as HTMLInputElement;
    expect(input.value).toBe("赵云.png");
    expect(container.querySelector(".topbar-name")).toBeNull();
    act(() => stopRename());
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector(".topbar-name")!.textContent).toBe("赵云.png");
  });
});

describe("TopBar 按钮焦点", () => {
  it("在按钮上按下指针被 preventDefault，点击仍然触发命令", () => {
    const { container } = render(<TopBar id={1} />);
    const btn = container.querySelector<HTMLButtonElement>(".topbar-info")!;
    const notCancelled = fireEvent.mouseDown(btn);
    expect(notCancelled).toBe(false);
    const back = container.querySelector<HTMLButtonElement>(".topbar-back")!;
    expect(fireEvent.mouseDown(back)).toBe(false);
    const before = useSingleUi.getState().infoOpen;
    fireEvent.click(btn);
    expect(useSingleUi.getState().infoOpen).toBe(!before);
  });
});

describe("TopBar 对比按钮", () => {
  it("篮空时禁用，N=2 显示“对比 · 2”并可进入对比", () => {
    useBasket.setState({ order: [], items: new Map(), missing: new Set() });
    const { container, rerender } = render(<TopBar id={1} />);
    const btn = container.querySelector<HTMLButtonElement>(".compare-btn")!;
    expect(btn.disabled).toBe(true);
    act(() => useBasket.setState({ order: [1, 2] }));
    rerender(<TopBar id={1} />);
    expect(btn.textContent).toBe(t("basket.button", { n: 2 }));
    expect(btn.disabled).toBe(false);
    expect(fireEvent.mouseDown(btn)).toBe(false);
    fireEvent.click(btn);
    expect(topView().kind).toBe("compare");
  });
});
