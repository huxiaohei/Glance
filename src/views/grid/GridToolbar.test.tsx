// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "../../app/openFolder";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import GridToolbar from "./GridToolbar";

vi.mock("../../app/openFolder", () => ({
  openFolder: vi.fn(),
  pickAndOpenFolder: vi.fn(),
  useOpenError: (sel: (s: { error: null }) => unknown) => sel({ error: null }),
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
});
