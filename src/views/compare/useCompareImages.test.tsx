// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../ipc/api";
import type { FileId } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { glanceUrl } from "../../lib/glanceUrl";
import { useThumbs } from "../../stores/thumbs";
import { cellSources, nextFull, useCompareImages } from "./useCompareImages";

vi.mock("../../ipc/api");

/** 只记下回调与被观察的元素，由测试手动报告进出视口。 */
class FakeIO {
  static last: FakeIO | null = null;
  targets: Element[] = [];
  constructor(public cb: IntersectionObserverCallback) {
    FakeIO.last = this;
  }
  observe(el: Element) { this.targets.push(el); }
  unobserve() {}
  disconnect() { this.targets = []; }
  fire(id: FileId, isIntersecting: boolean) {
    const target = this.targets.find((t) => (t as HTMLElement).dataset.id === String(id))!;
    act(() => this.cb([{ target, isIntersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
}

const ITEM: BasketItem = { id: 1, name: "a.png", dirName: "d", size: 10, mtimeMs: 5, width: 1024, height: 1536 };
const ORIGINAL = glanceUrl("image/1?v=5-10");
const THUMB = glanceUrl("thumb/1/640?v=5-10");
const IDS: FileId[] = [1];

function Harness({ long }: { long: number }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const full = useCompareImages(el, IDS, new Map([[1, long]]));
  const ready = useThumbs((s) => s.ready.get(1));
  const { thumb, original } = cellSources(ITEM, ready, full.has(1));
  return (
    <div ref={setEl}>
      <div data-id="1">
        <img className="shown" src={original ?? thumb ?? ""} alt="" />
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.mocked(api.thumbsWant).mockResolvedValue([]);
  useThumbs.getState().reset();
  useThumbs.getState().markReady([{ id: 1, v: "5-10" }], 640);
});
afterEach(() => vi.unstubAllGlobals());

describe("nextFull（换原图的滞后）", () => {
  const vis = new Set<FileId>([1]);
  it("没在用原图时显示长边要超过 640 × 1.1 才换", () => {
    expect(nextFull(new Set(), [1], vis, new Map([[1, 700]])).has(1)).toBe(false);
    expect(nextFull(new Set(), [1], vis, new Map([[1, 705]])).has(1)).toBe(true);
  });
  it("已在用原图时降到 640 × 0.9 以下才换回缩略图", () => {
    expect(nextFull(new Set([1]), [1], vis, new Map([[1, 600]])).has(1)).toBe(true);
    expect(nextFull(new Set([1]), [1], vis, new Map([[1, 570]])).has(1)).toBe(false);
  });
  it("不在视口或已不在列表里的不用原图", () => {
    expect(nextFull(new Set([1]), [1], new Set(), new Map([[1, 2000]])).size).toBe(0);
    expect(nextFull(new Set([1]), [], vis, new Map([[1, 2000]])).size).toBe(0);
  });
});

describe("useCompareImages", () => {
  it("向后端登记所有 id 的 640 缩略图（消费者 compare），卸载时撤销", () => {
    const { unmount } = render(<Harness long={2000} />);
    expect(api.thumbsWant).toHaveBeenCalledWith("compare", [1], 640);
    unmount();
    expect(api.thumbsWant).toHaveBeenLastCalledWith("compare", [], 640);
  });

  it("格子进入视口且显示尺寸大于 640 时用原图地址，离开视口后回到缩略图地址", () => {
    const { container } = render(<Harness long={2000} />);
    const img = () => container.querySelector<HTMLImageElement>(".shown")!.getAttribute("src");
    expect(img()).toBe(THUMB);
    FakeIO.last!.fire(1, true);
    expect(img()).toBe(ORIGINAL);
    FakeIO.last!.fire(1, false);
    expect(img()).toBe(THUMB);
  });

  it("在视口里但显示尺寸不到 640 时仍用缩略图", () => {
    const { container } = render(<Harness long={500} />);
    FakeIO.last!.fire(1, true);
    expect(container.querySelector(".shown")!.getAttribute("src")).toBe(THUMB);
  });
});

describe("cellSources", () => {
  it("缩略图版本与条目不一致时不用（尺寸可能已变）", () => {
    expect(cellSources(ITEM, { tier: 640, v: "1-1" }, false)).toEqual({ thumb: null, original: null });
    expect(cellSources(ITEM, undefined, true)).toEqual({ thumb: null, original: ORIGINAL });
  });
});
