// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "../../app/openFolder";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { t } from "../../i18n";
import GridToolbar from "./GridToolbar";

vi.mock("../../app/openFolder", () => ({
  openFolder: vi.fn(),
  pickAndOpenFolder: vi.fn(),
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
});
