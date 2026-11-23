// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileCommands } from "../../app/fileCommands";
import { trashTargets } from "../../app/fileOps";
import { formatKey } from "../../app/keys";
import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import { useSelection } from "../../stores/selection";
import { selectOnly, toggle } from "../../lib/selection";
import StatusBar from "./StatusBar";

vi.mock("../../app/fileOps", () => ({ trashTargets: vi.fn(), undoLast: vi.fn() }));
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
});
