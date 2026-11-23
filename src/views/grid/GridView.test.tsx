// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickAndOpenFolder } from "../../app/openFolder";
import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import GridView from "./GridView";

vi.mock("../../ipc/api");
vi.mock("../../app/openFolder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/openFolder")>()),
  pickAndOpenFolder: vi.fn(),
}));

beforeEach(() => {
  useCatalog.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true });
  vi.mocked(pickAndOpenFolder).mockClear();
});

describe("GridView 空状态", () => {
  it("rootGone 时显示目录已被移走的说明与打开其他目录按钮", () => {
    const s = useCatalog.getState();
    s.begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
    s.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
    s.apply({ type: "done", generation: 1, total: 1 });
    render(<GridView />);
    expect(screen.queryByText(t("grid.rootGone"))).toBeNull();

    act(() => {
      useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] });
      useCatalog.getState().apply({ type: "rootGone", generation: 1 });
    });
    const note = screen.getByText(t("grid.rootGone"));
    expect(screen.queryByText(t("grid.empty"))).toBeNull();
    const emptyState = note.parentElement!;
    fireEvent.click(within(emptyState).getByRole("button", { name: t("grid.openOther") }));
    expect(pickAndOpenFolder).toHaveBeenCalledTimes(1);
  });
});
