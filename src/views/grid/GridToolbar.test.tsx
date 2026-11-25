// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "../../app/openFolder";
import { popup } from "../../app/nativeMenu";
import { useRecents } from "../../stores/recents";
import { recentsList } from "../../ipc/api";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { topView, useNav } from "../../stores/nav";
import GridToolbar from "./GridToolbar";

vi.mock("../../app/openFolder", () => ({
  openFolder: vi.fn(),
  pickAndOpenFolder: vi.fn(),
}));

vi.mock("../../app/nativeMenu", () => ({ popup: vi.fn() }));
vi.mock("../../ipc/api", () => ({
  recentsList: vi.fn(),
  recentsPin: vi.fn(),
  recentsRemove: vi.fn(),
}));

describe("GridToolbar", () => {
  beforeEach(() => {
    vi.mocked(openFolder).mockResolvedValue("unreadable");
    useCatalog.setState({
      root: { generation: 1, path: "/p", name: "p", recursive: false, focus: null },
    });
    useListView.setState({ includeSubdirs: false });
  });

  it("打开“包含子目录”触发重扫；重扫失败时开关恢复为关", async () => {
    render(<GridToolbar />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(openFolder).toHaveBeenCalledWith("/p", true);
    await waitFor(() => expect(useListView.getState().includeSubdirs).toBe(false));
  });

  it("不再渲染打开失败的文字（改由提示条显示）", async () => {
    const { container } = render(<GridToolbar />);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(useListView.getState().includeSubdirs).toBe(false));
    expect(container.textContent).not.toContain(t("error.unreadable"));
    expect(container.querySelector(".grid-error")).toBeNull();
  });

  it("目录名是按钮，点击后立刻用已有的最近目录弹出菜单，并在后台重新读取", async () => {
    const other = { path: "/q", name: "q", count: null, thumbs: [], pinned: false, exists: true, sort: null, includeSubdirs: null };
    vi.mocked(popup).mockReset();
    vi.mocked(popup).mockResolvedValue(undefined);
    vi.mocked(recentsList).mockReset();
    vi.mocked(recentsList).mockReturnValue(new Promise(() => {}));   // 后台读取一直不返回
    useRecents.setState({ list: [other] });
    render(<GridToolbar />);
    const btn = screen.getByRole("button", { name: "p" });
    expect(btn.className).toContain("grid-root");
    expect(btn.getAttribute("title")).toBe("/p");
    fireEvent.click(btn);
    await waitFor(() => expect(popup).toHaveBeenCalled());
    expect(recentsList).toHaveBeenCalledTimes(1);
    const nodes = vi.mocked(popup).mock.calls[0][0];
    expect(nodes.map((n) => (n.kind === "item" ? n.label : "|"))).toEqual(["q — /q", "|", t("grid.openOther")]);
  });

  it("排序与大小控件有 aria-label", () => {
    render(<GridToolbar />);
    expect(screen.getByRole("combobox", { name: t("toolbar.sort") })).toBeTruthy();
    expect(screen.getByRole("slider", { name: t("toolbar.size") })).toBeTruthy();
  });

  it("“对比 · N”按钮：篮空时禁用，N=2 时显示并可进入对比；点击后不留焦点", () => {
    useBasket.setState({ order: [], items: new Map(), missing: new Set() });
    useNav.getState().reset();
    const { rerender } = render(<GridToolbar />);
    const btn0 = screen.getByRole("button", { name: t("basket.button", { n: 0 }) }) as HTMLButtonElement;
    expect(btn0.disabled).toBe(true);
    useBasket.setState({ order: [1, 2] });
    rerender(<GridToolbar />);
    const btn = screen.getByRole("button", { name: t("basket.button", { n: 2 }) }) as HTMLButtonElement;
    expect(btn.textContent).toBe(t("basket.button", { n: 2 }));
    expect(btn.disabled).toBe(false);
    expect(fireEvent.mouseDown(btn)).toBe(false);
    fireEvent.click(btn);
    expect(topView().kind).toBe("compare");
  });
});
