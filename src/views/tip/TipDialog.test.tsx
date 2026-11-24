// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { useTip } from "../../stores/tip";
import TipDialog from "./TipDialog";

afterEach(() => useTip.setState({ open: false }));

describe("TipDialog", () => {
  it("open 为假时不渲染", () => {
    const { container } = render(<TipDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("打开时有 role=dialog、标题与两张二维码", () => {
    useTip.setState({ open: true });
    render(<TipDialog />);
    const dialog = screen.getByRole("dialog", { name: t("tip.title") });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText(t("tip.title"))).toBeTruthy();
    expect(screen.getByAltText(t("tip.wechat"))).toBeTruthy();
    expect(screen.getByAltText(t("tip.alipay"))).toBeTruthy();
  });

  it("点关闭按钮关闭", () => {
    useTip.setState({ open: true });
    render(<TipDialog />);
    fireEvent.click(screen.getByRole("button", { name: t("settings.close") }));
    expect(useTip.getState().open).toBe(false);
  });

  it("点背景关闭，点面板内部不关闭", () => {
    useTip.setState({ open: true });
    render(<TipDialog />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(useTip.getState().open).toBe(true);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(useTip.getState().open).toBe(false);
  });
});
