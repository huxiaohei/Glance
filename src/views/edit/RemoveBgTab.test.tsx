// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { EditOpened, RemoveBgMemory } from "../../ipc/types";
import { useEditUi } from "../../stores/editUi";
import EditLayer from "./EditLayer";
import RemoveBgTab from "./RemoveBgTab";

vi.mock("../../ipc/api");

const initial = useEditUi.getState();
const patch = vi.fn();
const opened = (o: Partial<EditOpened> = {}): EditOpened => ({
  session: 1, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat: "png", hasAlpha: true, fileSize: 1000, ...o,
});
const base: RemoveBgMemory = { mode: "color", threshold: 16, below: true, tolerance: 10, softness: 10, edgeConnected: true };

function setup(o: { removeBg?: Partial<RemoveBgMemory>; hasAlpha?: boolean; bgColor?: [number, number, number] | null } = {}) {
  act(() =>
    useEditUi.setState({
      status: "ready",
      id: 2,
      tab: "removeBg",
      opened: opened({ hasAlpha: o.hasAlpha ?? true }),
      removeBg: { ...base, ...o.removeBg },
      bgColor: o.bgColor === undefined ? [255, 0, 16] : o.bgColor,
      patch,
    }),
  );
  return render(<RemoveBgTab />);
}

const slider = (name: string) => screen.getByRole("slider", { name }) as HTMLInputElement;

beforeEach(() => patch.mockClear());
afterEach(() => act(() => useEditUi.setState(initial, true)));

describe("去背景页签", () => {
  it("mode_switch_patches_remove_bg", () => {
    setup();
    const alpha = screen.getByRole("radio", { name: t("edit.removeBg.mode.alpha") }) as HTMLInputElement;
    const color = screen.getByRole("radio", { name: t("edit.removeBg.mode.color") }) as HTMLInputElement;
    expect(color.checked).toBe(true);
    expect(alpha.disabled).toBe(false);
    fireEvent.click(alpha);
    expect(patch).toHaveBeenCalledWith("removeBg", { mode: "alpha" });
  });

  it("alpha_disabled_without_alpha_with_note", () => {
    setup({ hasAlpha: false });
    const alpha = screen.getByRole("radio", { name: t("edit.removeBg.mode.alpha") }) as HTMLInputElement;
    expect(alpha.disabled).toBe(true);
    expect(screen.getByText(t("edit.removeBg.noAlpha"))).toBeTruthy();
    fireEvent.click(alpha);
    expect(patch).not.toHaveBeenCalled();
  });

  it("no_alpha_note_hidden_when_has_alpha", () => {
    setup();
    expect(screen.queryByText(t("edit.removeBg.noAlpha"))).toBeNull();
  });

  it("alpha_mode_threshold_and_direction", () => {
    setup({ removeBg: { mode: "alpha", threshold: 40, below: true } });
    const th = slider(t("edit.removeBg.threshold"));
    expect(th.min).toBe("0");
    expect(th.max).toBe("255");
    expect(th.value).toBe("40");
    fireEvent.change(th, { target: { value: "200" } });
    expect(patch).toHaveBeenLastCalledWith("removeBg", { threshold: 200 });
    const below = screen.getByRole("radio", { name: t("edit.removeBg.below") }) as HTMLInputElement;
    const above = screen.getByRole("radio", { name: t("edit.removeBg.above") }) as HTMLInputElement;
    expect(below.checked).toBe(true);
    fireEvent.click(above);
    expect(patch).toHaveBeenLastCalledWith("removeBg", { below: false });
    // 按颜色的控件不出现
    expect(screen.queryByText(t("edit.removeBg.pickHint"))).toBeNull();
    expect(screen.queryByRole("slider", { name: t("edit.removeBg.tolerance") })).toBeNull();
  });

  it("color_mode_shows_swatch_hint_and_controls", () => {
    const { container } = setup({ removeBg: { tolerance: 25, softness: 5, edgeConnected: true } });
    const swatch = container.querySelector(".edit-swatch") as HTMLElement;
    expect(swatch.style.backgroundColor).toBe("rgb(255, 0, 16)");
    expect(screen.getByText("#FF0010")).toBeTruthy();
    expect(screen.getByText(t("edit.removeBg.pickHint"))).toBeTruthy();

    const tol = slider(t("edit.removeBg.tolerance"));
    expect([tol.min, tol.max, tol.value]).toEqual(["0", "100", "25"]);
    fireEvent.change(tol, { target: { value: "60" } });
    expect(patch).toHaveBeenLastCalledWith("removeBg", { tolerance: 60 });

    const soft = slider(t("edit.removeBg.softness"));
    expect([soft.min, soft.max, soft.value]).toEqual(["0", "100", "5"]);
    fireEvent.change(soft, { target: { value: "0" } });
    expect(patch).toHaveBeenLastCalledWith("removeBg", { softness: 0 });

    const edge = screen.getByRole("checkbox", { name: t("edit.removeBg.edgeConnected") }) as HTMLInputElement;
    expect(edge.checked).toBe(true);
    fireEvent.click(edge);
    expect(patch).toHaveBeenLastCalledWith("removeBg", { edgeConnected: false });
    fireEvent.click(screen.getByRole("radio", { name: t("edit.removeBg.mode.color") }));
    // 已是当前方式：不重复写
    expect(patch).toHaveBeenCalledTimes(3);
    // alpha 方式的控件不出现
    expect(screen.queryByRole("slider", { name: t("edit.removeBg.threshold") })).toBeNull();
  });

  it("swatch_follows_bg_color", () => {
    setup({ bgColor: [1, 2, 3] });
    expect(screen.getByText("#010203")).toBeTruthy();
    act(() => useEditUi.setState({ bgColor: [0, 128, 255] }));
    expect(screen.getByText("#0080FF")).toBeTruthy();
  });
});

describe("EditLayer 棋盘格", () => {
  it("checker_only_on_remove_bg_tab", () => {
    act(() => useEditUi.setState({ status: "ready", id: 2, tab: "removeBg", opened: opened() }));
    const { container } = render(<EditLayer onEl={() => {}} />);
    const layer = () => container.querySelector(".edit-layer") as HTMLElement;
    expect(layer().classList.contains("is-checker")).toBe(true);
    for (const tab of ["compress", "convert", "crop"] as const) {
      act(() => useEditUi.setState({ tab }));
      expect(layer().classList.contains("is-checker")).toBe(false);
    }
  });
});
