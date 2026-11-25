// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../i18n";
import * as api from "../../ipc/api";
import type { FileId, RootInfo } from "../../ipc/types";
import { basketItem, useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi } from "../../stores/compareUi";
import { useListView } from "../../stores/listView";
import { useToast } from "../../stores/toast";
import ComparePanel from "./ComparePanel";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const ROOT: RootInfo = { generation: 1, path: "/三国", name: "三国", recursive: true, focus: null };

function openRoot(relPaths: string[]) {
  useCatalog.getState().begin(ROOT);
  useCatalog.getState().apply({
    type: "batch", generation: 1, entries: relPaths.map((relPath, i) => ({ id: i + 1, relPath, size: 10, mtimeMs: 5 })),
  });
  useCatalog.getState().apply({ type: "done", generation: 1, total: relPaths.length });
}

const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".compare-panel-item")];
const itemOf = (c: HTMLElement, id: FileId) => c.querySelector<HTMLElement>(`.compare-panel-item[data-id="${id}"]`)!;
const select = () => screen.getByRole("combobox") as HTMLSelectElement;

beforeEach(() => {
  setLanguage("zh-CN");
  useCatalog.getState().reset();
  useListView.setState({ sort: "name", includeSubdirs: true, dirFilter: null, collapsed: new Set() });
  useBasket.setState({ order: [], items: new Map(), missing: new Set() });
  useCompareUi.setState({ panelOpen: true, panelSource: { kind: "root" }, otherDir: null });
  useToast.setState({ current: null });
  vi.mocked(api.thumbsWant).mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("ComparePanel", () => {
  it("标题、说明；当前文件夹列出全部图片，title 是文件名", () => {
    openRoot(["b.png", "a.png", "魏国/曹操.png"]);
    const { container } = render(<ComparePanel />);
    expect(screen.getByText("添加图片")).toBeTruthy();
    expect(screen.getByText("点击缩略图加入对比")).toBeTruthy();
    expect(items(container).map((el) => el.title)).toEqual(["a.png", "b.png", "曹操.png"]);
    const labels = [...select().options].map((o) => o.textContent);
    expect(labels[0]).toBe("当前文件夹 · 3 张");
    expect(labels.some((l) => l?.includes("魏国 · 1 张"))).toBe(true);
    expect(labels[labels.length - 1]).toBe("其他文件夹…");
  });

  it("点缩略图加入，再点移出；已在篮中的有琥珀点", () => {
    openRoot(["a.png", "b.png"]);
    const { container } = render(<ComparePanel />);
    expect(itemOf(container, 2).querySelector(".compare-panel-badge")).toBeNull();
    fireEvent.click(itemOf(container, 2));
    expect(useBasket.getState().order).toEqual([2]);
    expect(itemOf(container, 2).querySelector(".compare-panel-badge")).not.toBeNull();
    fireEvent.click(itemOf(container, 2));
    expect(useBasket.getState().order).toEqual([]);
    expect(itemOf(container, 2).querySelector(".compare-panel-badge")).toBeNull();
  });

  it("选子目录只列该目录（及其子目录）", () => {
    openRoot(["a.png", "魏国/曹操.png", "魏国/将/张辽.png"]);
    const { container } = render(<ComparePanel />);
    fireEvent.change(select(), { target: { value: "dir:魏国" } });
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "dir", dir: "魏国" });
    expect(items(container).map((el) => el.title)).toEqual(["曹操.png", "张辽.png"]);
    expect(useListView.getState().dirFilter).toBeNull();
  });

  it("其他文件夹…：列表换成扫描结果，点击后篮内快照取自该结果；再选回会重新扫描", async () => {
    openRoot(["a.png"]);
    vi.mocked(openDialog).mockResolvedValue("/吴国");
    vi.mocked(api.browseDir).mockResolvedValue({
      name: "吴国",
      entries: [
        { id: 90, name: "孙权10.png", size: 7, mtimeMs: 3 },
        { id: 91, name: "孙权2.png", size: 8, mtimeMs: 4 },
      ],
    });
    const { container } = render(<ComparePanel />);
    fireEvent.change(select(), { target: { value: "pick" } });
    await waitFor(() => expect(items(container).map((el) => el.title)).toEqual(["孙权2.png", "孙权10.png"]));
    expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(api.browseDir).toHaveBeenCalledWith("/吴国");
    expect(select().value).toBe("other");
    expect([...select().options].some((o) => o.textContent === "吴国 · 2 张")).toBe(true);

    fireEvent.click(itemOf(container, 91));
    expect(useBasket.getState().order).toEqual([91]);
    expect(basketItem(91)).toEqual({ id: 91, name: "孙权2.png", dirName: "吴国", size: 8, mtimeMs: 4 });

    fireEvent.change(select(), { target: { value: "root" } });
    expect(items(container).map((el) => el.title)).toEqual(["a.png"]);
    fireEvent.change(select(), { target: { value: "other" } });
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(api.browseDir).toHaveBeenCalledTimes(2);
    expect(openDialog).toHaveBeenCalledTimes(1);
  });

  it("对话框取消：来源不变", async () => {
    openRoot(["a.png", "魏国/曹操.png"]);
    useCompareUi.setState({ panelSource: { kind: "dir", dir: "魏国" } });
    vi.mocked(openDialog).mockResolvedValue(null);
    const { container } = render(<ComparePanel />);
    fireEvent.change(select(), { target: { value: "pick" } });
    await act(async () => {});
    expect(openDialog).toHaveBeenCalled();
    expect(api.browseDir).not.toHaveBeenCalled();
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "dir", dir: "魏国" });
    expect(select().value).toBe("dir:魏国");
    expect(items(container).map((el) => el.title)).toEqual(["曹操.png"]);
  });

  it("扫描失败：提示，来源不变", async () => {
    openRoot(["a.png"]);
    vi.mocked(openDialog).mockResolvedValue("/坏");
    vi.mocked(api.browseDir).mockRejectedValue(new Error("x"));
    render(<ComparePanel />);
    fireEvent.change(select(), { target: { value: "pick" } });
    await waitFor(() => expect(useToast.getState().current?.text).toBe("无法读取这个文件夹"));
    expect(useCompareUi.getState().panelSource).toEqual({ kind: "root" });
    expect(useCompareUi.getState().otherDir).toBeNull();
  });

  it("没有打开目录时只有“其他文件夹…”", () => {
    const { container } = render(<ComparePanel />);
    const opts = [...select().options].filter((o) => !o.hidden);
    expect(opts.map((o) => o.textContent)).toEqual(["其他文件夹…"]);
    expect(items(container)).toHaveLength(0);
  });

  it("虚拟化：2000 张时只渲染可视行附近", () => {
    openRoot(Array.from({ length: 2000 }, (_, i) => `img${i}.png`));
    const { container } = render(<ComparePanel />);
    const n = items(container).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(100);
  });

  it("登记可视格子的缩略图需求，卸载时撤销", async () => {
    openRoot(["a.png", "b.png"]);
    const { unmount } = render(<ComparePanel />);
    await waitFor(() => expect(api.thumbsWant).toHaveBeenCalledWith("comparePanel", [1, 2], 320));
    unmount();
    expect(api.thumbsWant).toHaveBeenLastCalledWith("comparePanel", [], 320);
  });
});
