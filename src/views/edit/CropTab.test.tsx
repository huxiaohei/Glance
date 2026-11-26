// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { CropMemory, CropState, EditOpened } from "../../ipc/types";
import { fitRatio, flip, resizeTo, rotate } from "../../lib/cropGeometry";
import { useEditUi } from "../../stores/editUi";
import CropTab from "./CropTab";

vi.mock("../../ipc/api");

const opened: EditOpened = {
  session: 5, width: 200, height: 100, proxyW: 200, proxyH: 100, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000,
};
const dims = { w: 200, h: 100 };
const bounds = dims;
const start: CropState = { rect: { x: 10, y: 10, w: 100, h: 50 }, quarterTurns: 0, flipH: false, flipV: false };
const mem = (o: Partial<CropMemory> = {}): CropMemory => ({ ratio: "free", customW: 3, customH: 2, portrait: false, ...o });

beforeEach(() => {
  useEditUi.setState({ status: "ready", id: 2, opened, tab: "crop", cropState: start, crop: mem() });
});
afterEach(() => {
  useEditUi.setState({ status: "idle", opened: null, cropState: null, crop: mem() });
});

const cs = () => useEditUi.getState().cropState!;
const btn = (name: string) => screen.getByRole("button", { name });

describe("CropTab", () => {
  it("比例预设：记住选择并在当前中心放下最大框", () => {
    render(<CropTab />);
    fireEvent.click(btn("1:1"));
    expect(useEditUi.getState().crop.ratio).toBe("1:1");
    expect(cs().rect).toEqual(fitRatio(start.rect, 1, bounds));
    const before = cs().rect;
    fireEvent.click(btn("16:9"));
    expect(cs().rect).toEqual(fitRatio(before, 16 / 9, bounds));
    // 自由：不动框
    const kept = cs().rect;
    fireEvent.click(btn(t("edit.crop.free")));
    expect(useEditUi.getState().crop.ratio).toBe("free");
    expect(cs().rect).toEqual(kept);
  });

  it("横竖互换切换 portrait 并按新比例放框；自由与 1:1 时不可用", () => {
    render(<CropTab />);
    const swap = btn(t("edit.crop.swap")) as HTMLButtonElement;
    expect(swap.disabled).toBe(true);
    fireEvent.click(btn("4:3"));
    expect(swap.disabled).toBe(false);
    const before = cs().rect;
    fireEvent.click(swap);
    expect(useEditUi.getState().crop.portrait).toBe(true);
    expect(cs().rect).toEqual(fitRatio(before, 3 / 4, bounds));
    expect(swap.getAttribute("aria-pressed")).toBe("true");
  });

  it("自定义显示两个输入，改动写进记忆并按新比例放框", () => {
    render(<CropTab />);
    expect(screen.queryByLabelText(t("edit.crop.customW"))).toBeNull();
    fireEvent.click(btn(t("edit.crop.custom")));
    const w = screen.getByLabelText(t("edit.crop.customW")) as HTMLInputElement;
    const h = screen.getByLabelText(t("edit.crop.customH")) as HTMLInputElement;
    expect(w.value).toBe("3");
    expect(h.value).toBe("2");
    const before = cs().rect;
    fireEvent.change(h, { target: { value: "1" } });
    expect(useEditUi.getState().crop.customH).toBe(1);
    expect(cs().rect).toEqual(fitRatio(before, 3, bounds));
    // 无效输入不采用
    fireEvent.change(w, { target: { value: "0" } });
    expect(useEditUi.getState().crop.customW).toBe(3);
  });

  it("宽高输入走 resizeTo；锁比例时另一边联动", () => {
    render(<CropTab />);
    const w = screen.getByLabelText(t("edit.crop.width")) as HTMLInputElement;
    const h = screen.getByLabelText(t("edit.crop.height")) as HTMLInputElement;
    expect(w.value).toBe("100");
    expect(h.value).toBe("50");
    fireEvent.change(w, { target: { value: "80" } });
    expect(cs().rect).toEqual(resizeTo(start.rect, 80, null, null, bounds));
    expect(cs().rect.h).toBe(50);
    fireEvent.blur(w);

    act(() => useEditUi.setState({ crop: mem({ ratio: "1:1" }), cropState: { ...start, rect: { x: 10, y: 10, w: 50, h: 50 } } }));
    fireEvent.change(h, { target: { value: "70" } });
    expect(cs().rect).toEqual(resizeTo({ x: 10, y: 10, w: 50, h: 50 }, null, 70, 1, bounds));
    expect(cs().rect.w).toBe(70);
    expect(w.value).toBe("70");
  });

  it("旋转、翻转、还原", () => {
    render(<CropTab />);
    fireEvent.click(btn(t("edit.crop.rotateRight")));
    const r1 = rotate(start, 1, dims);
    expect(cs()).toEqual(r1);
    fireEvent.click(btn(t("edit.crop.rotateLeft")));
    expect(cs()).toEqual(rotate(r1, -1, dims));
    const s2 = cs();
    fireEvent.click(btn(t("edit.crop.flipH")));
    expect(cs()).toEqual(flip(s2, "h", dims));
    const s3 = cs();
    fireEvent.click(btn(t("edit.crop.flipV")));
    expect(cs()).toEqual(flip(s3, "v", dims));
    fireEvent.click(btn(t("edit.crop.reset")));
    expect(cs()).toEqual({ rect: { x: 0, y: 0, w: 200, h: 100 }, quarterTurns: 0, flipH: false, flipV: false });
  });
});
