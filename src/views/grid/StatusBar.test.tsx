// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileCommands } from "../../app/fileCommands";
import { pickAndTransfer, trashTargets } from "../../app/fileOps";
import { formatKey } from "../../app/keys";
import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import { useSelection } from "../../stores/selection";
import { selectOnly, toggle } from "../../lib/selection";
import { useBasket } from "../../stores/basket";
import { registerBasketCommands } from "../../app/basketCommands";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import StatusBar from "./StatusBar";
import { enterBatch } from "../../app/batchMode";
import { registerGridCommands } from "./gridCommands";
import { useBatch } from "../../stores/batch";
import { useGridCtx } from "../../stores/gridCtx";

vi.mock("../../app/fileOps", () => ({ opTargets: () => [1, 2, 3].filter((id) => useSelection.getState().ids.has(id)), trashTargets: vi.fn(), undoLast: vi.fn(), pickAndTransfer: vi.fn(), transferToNewChild: vi.fn() }));
vi.mock("../../app/batchMode", () => ({ enterBatch: vi.fn() }));
vi.mock("../edit/editCommands", () => ({ enterEdit: vi.fn() }));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

let off = () => {};
afterEach(() => {
  off();
  off = () => {};
  vi.clearAllMocks();
});

describe("StatusBar", () => {
  beforeEach(() => {
    useCatalog.getState().reset();
    useSelection.getState().clear();
    useBasket.setState({ order: [], items: new Map(), missing: new Set() });
  });

  it("篮内有图时显示“对比篮 N 张”，没有则不显示", () => {
    useBasket.setState({ order: [], items: new Map(), missing: new Set() });
    const { rerender } = render(<StatusBar total={3} />);
    expect(screen.queryByText(t("basket.status", { n: 2 }))).toBeNull();
    useBasket.setState({ order: [1, 2] });
    rerender(<StatusBar total={3} />);
    expect(screen.getByText(t("basket.status", { n: 2 }))).toBeTruthy();
  });

  it("显示总数", () => {
    render(<StatusBar total={3} />);
    expect(screen.getByText(t("grid.total", { n: 3 }))).toBeTruthy();
    expect(screen.queryByText(t("status.watchFailed"))).toBeNull();
  });

  it("监听失败时显示提示，总数仍在", () => {
    useCatalog.setState({ watchFailed: true });
    render(<StatusBar total={3} />);
    expect(screen.getByText(t("status.watchFailed"))).toBeTruthy();
    expect(screen.getByText(t("grid.total", { n: 3 }))).toBeTruthy();
  });

  it("有选中时显示已选张数", () => {
    useSelection.getState().set(toggle(selectOnly(1), 2));
    render(<StatusBar total={3} />);
    expect(screen.getByText(t("grid.total", { n: 3 }))).toBeTruthy();
    expect(screen.getByText(t("status.selected", { n: 2 }))).toBeTruthy();
  });

  it("总数与已选数之间渲染 status.sep", () => {
    useSelection.getState().set(selectOnly(1));
    const { container } = render(<StatusBar total={3} />);
    const spans = container.querySelectorAll(".status-counts > span");
    expect(spans[1].textContent).toBe(t("status.sep"));
    expect(container.querySelector(".status-counts")!.textContent).toBe(
      `${t("grid.total", { n: 3 })}${t("status.sep")}${t("status.selected", { n: 1 })}`,
    );
  });

  it("没有选中时不显示已选", () => {
    render(<StatusBar total={3} />);
    expect(screen.queryByText(t("status.selected", { n: 0 }))).toBeNull();
  });

  it("有选中时出现删除按钮，点击调用 trashTargets", () => {
    off = registerFileCommands(true);
    useSelection.getState().set(selectOnly(1));
    render(<StatusBar total={3} />);
    const btn = screen.getByRole("button", { name: t("status.delete") });
    expect(btn.getAttribute("title")).toBe(`${t("cmd.file.trash")} (${formatKey("Mod+Backspace", true)})`);
    fireEvent.click(btn);
    expect(trashTargets).toHaveBeenCalledTimes(1);
  });

  it("没有选中时没有删除按钮", () => {
    render(<StatusBar total={3} />);
    expect(screen.queryByRole("button", { name: t("status.delete") })).toBeNull();
  });

  it("有选中时出现移动按钮，点击调用 pickAndTransfer(\"move\")；没有选中时没有", () => {
    off = registerFileCommands(true);
    const { unmount } = render(<StatusBar total={3} />);
    expect(screen.queryByRole("button", { name: t("status.move") })).toBeNull();
    unmount();
    useSelection.getState().set(selectOnly(1));
    render(<StatusBar total={3} />);
    const btn = screen.getByRole("button", { name: t("status.move") });
    expect(btn.getAttribute("title")).toBe(t("cmd.file.moveTo"));
    fireEvent.click(btn);
    expect(pickAndTransfer).toHaveBeenCalledWith("move");
  });

  it("选中一张不在篮里：底部出现加入对比提示（键名取自命令表）；关掉设置后不出现", () => {
    off = registerBasketCommands();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    useSelection.getState().set(selectOnly(1));
    const { container, rerender } = render(<StatusBar total={3} />);
    const hints = container.querySelector(".status-bar .key-hints");
    expect(hints).not.toBeNull();
    expect(hints!.textContent).toContain("Space");
    expect(hints!.textContent).toContain(t("hint.basket.add", { n: 1 }));
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, showKeyHints: false } }));
    rerender(<StatusBar total={3} />);
    expect(container.querySelector(".key-hints")).toBeNull();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  it("选中的已在篮里：提示移出对比与进入对比", () => {
    off = registerBasketCommands();
    useBasket.setState({ order: [1, 2] });
    useSelection.getState().set(selectOnly(1));
    const { container } = render(<StatusBar total={3} />);
    const text = container.querySelector(".key-hints")!.textContent;
    expect(text).toContain(t("hint.basket.remove"));
    expect(text).toContain(t("hint.compare.open", { n: 2 }));
  });

  describe("批量入口", () => {
    beforeEach(() => {
      off = registerGridCommands();
      useGridCtx.setState({ list: { ids: [1, 2, 3], groups: [{ dir: "", start: 0, count: 3, total: 3 }] } });
    });
    afterEach(() => useBatch.setState({ job: null, progress: null }));

    it("没有选中：没有压缩 / 转格式按钮", () => {
      render(<StatusBar total={3} />);
      expect(screen.queryByRole("button", { name: t("status.compress") })).toBeNull();
      expect(screen.queryByRole("button", { name: t("status.convert") })).toBeNull();
    });

    it("选中 2 张：点“压缩”进入批量压缩，点“转格式”进入批量转格式", () => {
      useSelection.getState().set({ ...selectOnly(1), ids: new Set([1, 2]), focus: 2 });
      render(<StatusBar total={3} />);
      fireEvent.click(screen.getByRole("button", { name: t("status.compress") }));
      expect(enterBatch).toHaveBeenLastCalledWith([1, 2], 2, "compress");
      fireEvent.click(screen.getByRole("button", { name: t("status.convert") }));
      expect(enterBatch).toHaveBeenLastCalledWith([1, 2], 2, "convert");
    });

    it("批量进行中按钮禁用并提示；任务结束后恢复", () => {
      useSelection.getState().set({ ...selectOnly(1), ids: new Set([1, 2]), focus: 1 });
      render(<StatusBar total={3} />);
      act(() => useBatch.setState({ job: 1, progress: { done: 0, total: 2, failed: 0 } }));
      const btn = screen.getByRole("button", { name: t("status.compress") }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toBe(t("batch.running"));
      act(() => useBatch.setState({ job: null, progress: null }));
      expect(btn.disabled).toBe(false);
    });
  });
});
