// @vitest-environment jsdom
import { vi } from "vitest";
vi.mock("../../app/contextMenu", () => ({ showImageMenu: vi.fn(async () => {}) }));
import { showImageMenu } from "../../app/contextMenu";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageEntry } from "../../lib/deriveList";
import { useNav } from "../../stores/nav";
import { stopRename, useRename } from "../../stores/rename";
import { useThumbs } from "../../stores/thumbs";
import { useSelection } from "../../stores/selection";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import ThumbCell from "./ThumbCell";

const entry: ImageEntry = { id: 1, relPath: "a.jpg", dir: "", name: "a.jpg", size: 10, mtimeMs: 5 };

describe("ThumbCell", () => {
  beforeEach(() => useThumbs.getState().reset());

  it("地址里的版本来自就绪状态，而不是条目", () => {
    useThumbs.setState({ ready: new Map([[1, { tier: 320, v: "99-77" }]]) });
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    expect(container.querySelector("img")!.getAttribute("src")).toMatch(/thumb\/1\/320\?v=99-77$/);
  });

  it("缩略图加载失败后改显占位", () => {
    useThumbs.setState({ ready: new Map([[1, { tier: 320, v: "5-10" }]]) });
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".thumb-placeholder")).not.toBeNull();
  });
});

describe("ThumbCell 重命名", () => {
  beforeEach(() => {
    useThumbs.getState().reset();
    useNav.getState().reset();
    stopRename();
  });

  it("双击文件名开始重命名而不进入单张视图；双击缩略图仍进入", () => {
    const openSingle = vi.spyOn(useNav.getState(), "openSingle");
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    fireEvent.doubleClick(container.querySelector(".thumb-name")!);
    expect(useRename.getState().id).toBe(1);
    expect(openSingle).not.toHaveBeenCalled();
    const input = container.querySelector(".thumb-name input") as HTMLInputElement;
    expect(input.value).toBe("a.jpg");

    act(() => stopRename());
    expect(container.querySelector("input")).toBeNull();
    fireEvent.doubleClick(container.querySelector(".thumb-box")!);
    expect(openSingle).toHaveBeenCalledWith(1);
    openSingle.mockRestore();
  });
});

describe("ThumbCell 右键菜单", () => {
  beforeEach(() => {
    useThumbs.getState().reset();
    stopRename();
    useSelection.getState().clear();
    vi.mocked(showImageMenu).mockClear();
  });

  it("contextmenu 先调整选中再弹菜单，并阻止系统默认菜单", () => {
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    const notPrevented = fireEvent.contextMenu(container.querySelector(".thumb-cell")!);
    expect(notPrevented).toBe(false);
    expect([...useSelection.getState().ids]).toEqual([1]);
    expect(showImageMenu).toHaveBeenCalledTimes(1);
  });

  it("重命名输入框里的右键保持系统菜单", () => {
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    fireEvent.doubleClick(container.querySelector(".thumb-name")!);
    const notPrevented = fireEvent.contextMenu(container.querySelector("input")!);
    expect(notPrevented).toBe(true);
    expect(showImageMenu).not.toHaveBeenCalled();
    act(() => stopRename());
  });
});

describe("ThumbCell 对比篮", () => {
  beforeEach(() => {
    useThumbs.getState().reset();
    useBasket.setState({ order: [], items: new Map(), missing: new Set() });
    useSelection.getState().clear();
    useCatalog.getState().reset();
    const c = useCatalog.getState();
    c.begin({ generation: 1, path: "/r", name: "r", recursive: false, focus: null });
    c.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.jpg", size: 10, mtimeMs: 5 }] });
  });

  it("在篮内显示角标，不在则没有", () => {
    const { container, rerender } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    expect(container.querySelector(".thumb-basket-badge")).toBeNull();
    act(() => useBasket.getState().toggle([1]));
    rerender(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    const badge = container.querySelector(".thumb-basket-badge")!;
    expect(badge.getAttribute("aria-label")).toBe(t("basket.inBasket"));
  });

  it("点悬停按钮加入对比，选中不变", () => {
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    const btn = container.querySelector<HTMLButtonElement>(".thumb-basket-btn")!;
    expect(btn.textContent).toBe(t("basket.add"));
    fireEvent.pointerDown(btn, { button: 0 });
    fireEvent.click(btn);
    expect(useBasket.getState().order).toEqual([1]);
    expect(useSelection.getState().ids.size).toBe(0);
    expect(btn.textContent).toBe(t("basket.remove"));
  });

  it("按下悬停按钮不抢键盘焦点（否则之后的空格会再次点它）", () => {
    const { container } = render(<ThumbCell entry={entry} cell={160} selected={false} focused={false} />);
    const btn = container.querySelector<HTMLButtonElement>(".thumb-basket-btn")!;
    // fireEvent 返回 false 表示默认行为被拦下
    expect(fireEvent.mouseDown(btn, { button: 0 })).toBe(false);
  });
});
