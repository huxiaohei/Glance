// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../i18n";
import type { BasketItem } from "../../lib/basket";
import { FIT_VIEWPORT } from "../../lib/compareViewport";
import { useThumbs } from "../../stores/thumbs";
import CompareCell from "./CompareCell";

vi.mock("../../ipc/api");

const ITEM: BasketItem = { id: 1, name: "a.png", dirName: "d", size: 10, mtimeMs: 5, width: 1024, height: 1536 };

function cell(missing = false, focused = false) {
  return (
    <CompareCell id={1} item={ITEM} missing={missing} odd={false} captions focused={focused}
      box={{ w: 200, h: 300 }} vp={FIT_VIEWPORT} full />
  );
}

beforeEach(() => {
  setLanguage("zh-CN");
  useThumbs.getState().markReady([{ id: 1, v: "5-10" }], 640);
});

describe("CompareCell", () => {
  it("原图加载失败：去掉原图层，缩略图仍在", () => {
    const { container } = render(cell());
    const pics = () => [...container.querySelectorAll<HTMLImageElement>(".compare-pic")];
    expect(pics()).toHaveLength(2);
    fireEvent.error(container.querySelector(".compare-original")!);
    expect(pics()).toHaveLength(1);
    expect(container.querySelector(".compare-original")).toBeNull();
  });

  it("有移出按钮，缺失的格也有", () => {
    const { container, rerender } = render(cell());
    expect(container.querySelector("button.compare-remove")?.getAttribute("aria-label")).toBe("移出对比");
    rerender(cell(true));
    expect(container.querySelector("button.compare-remove")).not.toBeNull();
  });
});
