// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import StageBasketButton from "./StageBasketButton";

vi.mock("../../ipc/api");

beforeEach(() => {
  useCatalog.getState().reset();
  useBasket.setState({ order: [], items: new Map(), missing: new Set() });
  const c = useCatalog.getState();
  c.begin({ generation: 1, path: "/r", name: "r", recursive: false, focus: null });
  c.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "a.png", size: 1, mtimeMs: 1 }] });
});

describe("StageBasketButton", () => {
  it("点击加入 / 移出；在篮内时为实心（active）", () => {
    const { container } = render(<StageBasketButton id={1} />);
    const btn = container.querySelector<HTMLButtonElement>("button")!;
    expect(btn.textContent).toBe(t("basket.add"));
    expect(btn.classList.contains("active")).toBe(false);
    expect(fireEvent.mouseDown(btn)).toBe(false);
    fireEvent.click(btn);
    expect(useBasket.getState().order).toEqual([1]);
    expect(btn.textContent).toBe(t("basket.remove"));
    expect(btn.classList.contains("active")).toBe(true);
    act(() => {});
    fireEvent.click(btn);
    expect(useBasket.getState().order).toEqual([]);
  });
});
