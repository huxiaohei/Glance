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

  it("目录名是按钮，点击后弹出最近目录菜单", async () => {
    const other = { path: "/q", name: "q", count: null, thumbs: [], pinned: false, exists: true, sort: null, includeSubdirs: null };
    vi.mocked(recentsList).mockResolvedValue([other]);
    useRecents.setState({ list: [] });
    render(<GridToolbar />);
    const btn = screen.getByRole("button", { name: "p" });
    expect(btn.className).toContain("grid-root");
    expect(btn.getAttribute("title")).toBe("/p");
    fireEvent.click(btn);
    await waitFor(() => expect(popup).toHaveBeenCalled());
    const nodes = vi.mocked(popup).mock.calls[0][0];
    expect(nodes.map((n) => (n.kind === "item" ? n.label : "|"))).toEqual(["q — /q", "|", t("grid.openOther")]);
  });

  it("排序与大小控件有 aria-label", () => {
    render(<GridToolbar />);
    expect(screen.getByRole("combobox", { name: t("toolbar.sort") })).toBeTruthy();
    expect(screen.getByRole("slider", { name: t("toolbar.size") })).toBeTruthy();
  });
});
