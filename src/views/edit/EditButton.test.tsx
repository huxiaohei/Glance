// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { editOpen } from "../../ipc/api";
import { useEditUi } from "../../stores/editUi";
import { useThumbs } from "../../stores/thumbs";
import { useToast } from "../../stores/toast";
import EditButton from "./EditButton";
import { enterEdit } from "./editCommands";

vi.mock("../../ipc/api");

beforeEach(() => {
  useThumbs.getState().reset();
  useToast.setState({ current: null });
});
afterEach(() => vi.clearAllMocks());

describe("EditButton", () => {
  it("缺系统解码组件时置灰，提示 codec.editTip，点了不进入编辑", () => {
    useThumbs.getState().apply({ type: "noCodec", id: 1 });
    const { container } = render(<EditButton id={1} />);
    const btn = container.querySelector(".topbar-edit") as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toBe(t("codec.editTip"));
    fireEvent.click(btn);
    expect(editOpen).not.toHaveBeenCalled();
  });

  it("没有缺组件标记时可用", () => {
    const { container } = render(<EditButton id={1} />);
    expect(container.querySelector(".topbar-edit")!.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("enterEdit", () => {
  it("打开时报 noCodec：提示条显示 codec.editTip，并记下缺组件", async () => {
    vi.mocked(editOpen).mockRejectedValue("noCodec");
    await act(() => enterEdit(1));
    expect(useToast.getState().current?.text).toBe(t("codec.editTip"));
    expect(useThumbs.getState().noCodec.has(1)).toBe(true);
    expect(useEditUi.getState().status).toBe("idle");
  });
});
