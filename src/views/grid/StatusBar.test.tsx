// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { useCatalog } from "../../stores/catalog";
import StatusBar from "./StatusBar";

describe("StatusBar", () => {
  beforeEach(() => useCatalog.getState().reset());

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
});
