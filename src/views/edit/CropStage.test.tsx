// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editSourceUrl } from "../../ipc/api";
import type { CropState, EditOpened } from "../../ipc/types";
import { cssTransform } from "../../lib/cropGeometry";
import { useEditUi } from "../../stores/editUi";
import CropStage from "./CropStage";

vi.mock("../../ipc/api");

// 画面尺寸：jsdom 不做布局，打桩
let boxW = 864;
let boxH = 464;
let restore: (() => void)[] = [];
const stubProp = (proto: object, prop: string, desc: PropertyDescriptor) => {
  const old = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, ...desc });
  restore.push(() => (old ? Object.defineProperty(proto, prop, old) : delete (proto as Record<string, unknown>)[prop]));
};

const opened: EditOpened = {
  session: 5, width: 200, height: 100, proxyW: 200, proxyH: 100, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000,
};
const state = (o: Partial<CropState> = {}): CropState => ({
  rect: { x: 10, y: 10, w: 100, h: 50 }, quarterTurns: 0, flipH: false, flipV: false, ...o,
});

function ready(cs: CropState) {
  useEditUi.setState({
    status: "ready", id: 2, opened, tab: "crop", cropState: cs,
    crop: { ratio: "free", customW: 3, customH: 2, portrait: false },
  });
}

beforeEach(() => {
  boxW = 864;
  boxH = 464;
  stubProp(HTMLElement.prototype, "clientWidth", { get: () => boxW });
  stubProp(HTMLElement.prototype, "clientHeight", { get: () => boxH });
  vi.mocked(editSourceUrl).mockImplementation((s) => `glance://localhost/edit/${s}/source`);
  ready(state());
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  restore = [];
  useEditUi.setState({ status: "idle", opened: null, cropState: null });
});

const img = (c: HTMLElement) => c.querySelector(".crop-img") as HTMLImageElement;
const cropBox = (c: HTMLElement) => c.querySelector(".crop-box") as HTMLElement;
const handle = (c: HTMLElement, h: string) => c.querySelector(`[data-handle="${h}"]`) as HTMLElement;

describe("CropStage", () => {
  it("显示源图，按适应窗口留 32 px 布局（可放大），transform 含旋转翻转", () => {
    const { container } = render(<CropStage />);
    const el = img(container);
    expect(el.getAttribute("src")).toBe("glance://localhost/edit/5/source");
    // scale = min((864-64)/200, (464-64)/100) = 4
    expect(el.style.width).toBe("800px");
    expect(el.style.height).toBe("400px");
    expect(el.style.left).toBe("32px");
    expect(el.style.top).toBe("32px");
    // jsdom 会化简 transform 写法：用同样写进样式后的结果比对
    const ref = document.createElement("div");
    ref.style.transform = cssTransform(state());
    expect(el.style.transform).toBe(ref.style.transform);
    act(() => useEditUi.getState().setCropState(state({ flipH: true, quarterTurns: 2 })));
    expect(img(container).style.transform).toContain(cssTransform(state({ flipH: true, quarterTurns: 2 })));
    // 框：rect × 4，相对画面左上角
    const b = cropBox(container);
    expect(b.style.left).toBe(`${32 + 40}px`);
    expect(b.style.top).toBe(`${32 + 40}px`);
    expect(b.style.width).toBe("400px");
    expect(b.style.height).toBe("200px");
    expect(container.querySelectorAll("[data-handle]:not([data-handle='move'])").length).toBe(8);
  });

  it("旋转 90° 后按转后尺寸布局，未转的图居中", () => {
    act(() => ready(state({ quarterTurns: 1, rect: { x: 0, y: 0, w: 100, h: 200 } })));
    const { container } = render(<CropStage />);
    const el = img(container);
    // 转后 100×200：scale = min(800/100, 400/200) = 2；未转的图 400×200 居中
    expect(el.style.width).toBe("400px");
    expect(el.style.height).toBe("200px");
    expect(el.style.left).toBe(`${(864 - 400) / 2}px`);
    expect(el.style.top).toBe(`${(464 - 200) / 2}px`);
    expect(el.style.transform).toContain("rotate(90deg)");
    const b = cropBox(container);
    expect(b.style.left).toBe(`${(864 - 200) / 2}px`);
    expect(b.style.top).toBe("32px");
    expect(b.style.height).toBe("400px");
  });

  it("拖右下控制点：拖动中只写 DOM，抬起时按位移 ÷ 缩放取整写入", () => {
    const { container } = render(<CropStage />);
    const h = handle(container, "se");
    fireEvent.pointerDown(h, { button: 0, buttons: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(h, { buttons: 1, clientX: 541, clientY: 339 });
    // 41/4 = 10.25 → 10；39/4 = 9.75 → 10
    expect(cropBox(container).style.width).toBe(`${110 * 4}px`);
    expect(cropBox(container).style.height).toBe(`${60 * 4}px`);
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 100, h: 50 });
    fireEvent.pointerUp(h, { button: 0, clientX: 541, clientY: 339 });
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 110, h: 60 });
    // 抬起后移动不再改
    fireEvent.pointerMove(h, { buttons: 0, clientX: 700, clientY: 400 });
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 110, h: 60 });
  });

  it("丢了 pointerup：主键已松开的移动结束拖动", () => {
    const { container } = render(<CropStage />);
    const h = handle(container, "se");
    fireEvent.pointerDown(h, { button: 0, buttons: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(h, { buttons: 1, clientX: 540, clientY: 340 });
    fireEvent.pointerMove(h, { buttons: 0, clientX: 580, clientY: 380 });
    // 按最后一次按住时的位置收尾
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 110, h: 60 });
    fireEvent.pointerMove(h, { buttons: 1, clientX: 400, clientY: 250 });
    expect(cropBox(container).style.width).toBe(`${110 * 4}px`);
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 110, h: 60 });
  });

  it("拖框内移动，不能拖出图片", () => {
    const { container } = render(<CropStage />);
    const b = cropBox(container);
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(b, { buttons: 1, clientX: 2000, clientY: 2000 });
    fireEvent.pointerUp(b, { button: 0 });
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 100, y: 50, w: 100, h: 50 });
  });

  it("自由比例下按住 Shift 拖角保持起始比例", () => {
    const { container } = render(<CropStage />);
    const h = handle(container, "se");
    fireEvent.pointerDown(h, { button: 0, buttons: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(h, { buttons: 1, clientX: 520, clientY: 340, shiftKey: true });
    fireEvent.pointerUp(h, { button: 0, shiftKey: true });
    // 起始 2:1；高变化幅度大：h = 60 → w = 120
    expect(useEditUi.getState().cropState!.rect).toEqual({ x: 10, y: 10, w: 120, h: 60 });
  });

  it("固定比例时始终锁定", () => {
    act(() => useEditUi.setState({ crop: { ratio: "1:1", customW: 3, customH: 2, portrait: false } }));
    act(() => useEditUi.getState().setCropState(state({ rect: { x: 10, y: 10, w: 50, h: 50 } })));
    const { container } = render(<CropStage />);
    const h = handle(container, "se");
    fireEvent.pointerDown(h, { button: 0, buttons: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(h, { buttons: 1, clientX: 540, clientY: 300 });
    fireEvent.pointerUp(h, { button: 0 });
    const r = useEditUi.getState().cropState!.rect;
    expect(r.w).toBe(r.h);
    expect(r.w).toBe(60);
  });

  it("pointerdown、wheel、dblclick 不冒泡到舞台", () => {
    const outer = { down: vi.fn(), wheel: vi.fn(), dbl: vi.fn() };
    function Host() {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const el = ref.current!;
        el.addEventListener("pointerdown", outer.down);
        el.addEventListener("wheel", outer.wheel);
        el.addEventListener("dblclick", outer.dbl);
      }, []);
      return (
        <div ref={ref}>
          <CropStage />
        </div>
      );
    }
    const { container } = render(<Host />);
    const root = container.querySelector(".crop-stage") as HTMLElement;
    fireEvent.pointerDown(root, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerDown(handle(container, "nw"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(root, { button: 0 });
    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    root.dispatchEvent(wheel);
    fireEvent.dblClick(cropBox(container));
    expect(outer.down).not.toHaveBeenCalled();
    expect(outer.wheel).not.toHaveBeenCalled();
    expect(outer.dbl).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(true);
  });
});
