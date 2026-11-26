// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleKeyDown } from "../../app/useKeyboard";
import { markSwitchStart, switchStats } from "../../lib/perfMarks";
import { wheelFactor } from "../../lib/viewport";
import { useCatalog } from "../../stores/catalog";
import { topView, useNav } from "../../stores/nav";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useEditUi } from "../../stores/editUi";
import { useThumbs } from "../../stores/thumbs";
import { Preloader } from "./preloader";
import Stage, { useStageApi } from "./Stage";
import { registerSingleCommands } from "./singleCommands";
import { useStageViewport, type StageApi } from "./useStageViewport";

vi.mock("../../ipc/api");
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

// 容器尺寸与位置：jsdom 不做布局，全部打桩
let boxW = 800;
let boxH = 600;
const LEFT = 100;
const TOP = 50;
let restore: (() => void)[] = [];
const stubProp = (proto: object, prop: string, desc: PropertyDescriptor) => {
  const old = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, ...desc });
  restore.push(() => (old ? Object.defineProperty(proto, prop, old) : delete (proto as Record<string, unknown>)[prop]));
};

// 可手动触发的 ResizeObserver
let observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
class ManualRO {
  rec: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.rec = { cb, targets: [] };
    observers.push(this.rec);
  }
  observe(t: Element) { this.rec.targets.push(t); }
  unobserve() {}
  disconnect() { observers = observers.filter((o) => o !== this.rec); }
}
const resizeTo = (w: number, h: number) => {
  boxW = w;
  boxH = h;
  act(() => {
    for (const o of observers) o.cb([], o as unknown as ResizeObserver);
  });
};

// 手动推进的 requestAnimationFrame
let frames: FrameRequestCallback[] = [];
const flush = () => {
  act(() => {
    const fs = frames;
    frames = [];
    for (const f of fs) f(0);
  });
};

// 预加载器：图片元素来自 jsdom，decode 立即成功；每个用例开始前三张都已就绪
let preloader: Preloader;
const url = (id: number) => `glance://localhost/image/${id}?v=1-1`;

beforeEach(async () => {
  boxW = 800;
  boxH = 600;
  frames = [];
  observers = [];
  stubProp(HTMLElement.prototype, "clientWidth", { get: () => boxW });
  stubProp(HTMLElement.prototype, "clientHeight", { get: () => boxH });
  stubProp(Element.prototype, "getBoundingClientRect", {
    value: () => ({ left: LEFT, top: TOP, x: LEFT, y: TOP, width: boxW, height: boxH, right: LEFT + boxW, bottom: TOP + boxH }),
  });
  vi.stubGlobal("ResizeObserver", ManualRO);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  useCatalog.getState().reset();
  useNav.getState().reset();
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: [1, 2, 3].map((id) => ({ id, relPath: `${id}.jpg`, size: 1, mtimeMs: 1 })),
    });
    useCatalog.getState().apply({
      type: "dims",
      generation: 1,
      items: [
        { id: 1, w: 2000, h: 1000 },
        { id: 2, w: 1000, h: 2000 },
      ],
    });
  });
  stubProp(HTMLImageElement.prototype, "decode", { value: () => Promise.resolve() });
  preloader = new Preloader();
  preloader.want([1, 2, 3].map((id) => ({ id, url: url(id) })));
  await new Promise((r) => setTimeout(r, 0));
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  restore = [];
  vi.unstubAllGlobals();
});

const img = (c: HTMLElement) => c.querySelector(".stage img") as HTMLImageElement;
const box = (c: HTMLElement) => c.querySelector(".stage") as HTMLElement;
const percent = (c: HTMLElement) => c.querySelector(".stage-percent")?.textContent ?? null;
function vp(c: HTMLElement) {
  // 样式序列化会把 translate(0px, 0px) 化简成 translate(0px)
  const m = /translate\((\S+?)px(?:, (\S+?)px)?\) scale\((\S+)\)/.exec(img(c).style.transform);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2] ?? 0), scale: Number(m[3]) };
}
const api = () => useStageApi.getState().api!;

describe("Stage", () => {
  it("初始为适应窗口并居中，百分比正确", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    expect(img(container).getAttribute("src")).toBe("glance://localhost/image/1?v=1-1");
    expect(img(container).style.width).toBe("2000px");
    expect(img(container).style.height).toBe("1000px");
    const v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.4);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(100);
    flush();
    expect(percent(container)).toBe("40%");
  });

  it("滚轮以鼠标位置为中心放大，并阻止默认行为", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    // 先走完挂载时排下的帧（切图计时要走两帧）
    flush();
    flush();
    const px = 200;
    const py = 300;
    const notPrevented = fireEvent.wheel(box(container), { deltaY: -100, clientX: LEFT + px, clientY: TOP + py });
    expect(notPrevented).toBe(false);
    const v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.4 * wheelFactor(-100, false));
    // 鼠标下的图片点不动（横向未触到边界）
    expect((px - v.x) / v.scale).toBeCloseTo(500);
    // 纵向仍不大于容器：居中
    expect(v.y).toBeCloseTo((600 - 1000 * v.scale) / 2);
    // 每帧最多更新一次百分比
    fireEvent.wheel(box(container), { deltaY: -100, clientX: LEFT + px, clientY: TOP + py });
    expect(frames.length).toBe(1);
    flush();
    expect(percent(container)).toBe(`${Math.round(vp(container)!.scale * 100)}%`);
    // 触控板捏合（ctrlKey）用更大的系数
    const before = vp(container)!.scale;
    fireEvent.wheel(box(container), { deltaY: -10, ctrlKey: true, clientX: LEFT + px, clientY: TOP + py });
    expect(vp(container)!.scale).toBeCloseTo(before * wheelFactor(-10, true));
  });

  it("wheel 为 switch 时滚轮向下切到下一张，画面比例不变", () => {
    act(() => useNav.getState().openSingle(1));
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, wheel: "switch" } });
    const { container } = render(<Stage id={1} preloader={preloader} />);
    const before = vp(container)!;
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.wheel(box(container), { deltaY: 100, clientX: LEFT + 200, clientY: TOP + 300 });
    });
    expect(notPrevented).toBe(false);
    const v = topView();
    expect(v.kind === "single" ? v.id : null).toBe(2);
    expect(vp(container)).toEqual(before);
  });

  it("wheel 为 switch 时按住 Ctrl 的滚轮仍然缩放", () => {
    act(() => useNav.getState().openSingle(1));
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, wheel: "switch" } });
    const { container } = render(<Stage id={1} preloader={preloader} />);
    act(() => {
      fireEvent.wheel(box(container), { deltaY: -10, ctrlKey: true, clientX: LEFT + 200, clientY: TOP + 300 });
    });
    expect(vp(container)!.scale).toBeCloseTo(0.4 * wheelFactor(-10, true));
    act(() => {
      fireEvent.wheel(box(container), { deltaY: -10, metaKey: true, clientX: LEFT + 200, clientY: TOP + 300 });
    });
    expect(vp(container)!.scale).toBeGreaterThan(0.4 * wheelFactor(-10, true));
    const v = topView();
    expect(v.kind === "single" ? v.id : null).toBe(1);
  });

  it("wheel 为 zoom 时滚轮缩放（原行为），不切图", () => {
    act(() => useNav.getState().openSingle(1));
    const { container } = render(<Stage id={1} preloader={preloader} />);
    act(() => {
      fireEvent.wheel(box(container), { deltaY: 100, clientX: LEFT + 200, clientY: TOP + 300 });
    });
    expect(vp(container)!.scale).toBeCloseTo(0.4 * wheelFactor(100, false));
    const v = topView();
    expect(v.kind === "single" ? v.id : null).toBe(1);
  });

  it("拖拽平移；图片不大于容器时拖拽不改变位置", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    const b = box(container);
    expect(b.style.cursor).toBe("");
    const before = vp(container);
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 1, clientX: 250, clientY: 330 });
    fireEvent.pointerUp(b, { button: 0, clientX: 250, clientY: 330 });
    expect(vp(container)).toEqual(before);

    act(() => api().actual());
    let v = vp(container)!;
    expect(v.scale).toBe(1);
    expect(v.x).toBeCloseTo(-600);
    expect(v.y).toBeCloseTo(-200);
    expect(b.style.cursor).toBe("grab");

    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    expect(b.style.cursor).toBe("grabbing");
    fireEvent.pointerMove(b, { buttons: 1, clientX: 250, clientY: 330 });
    v = vp(container)!;
    expect(v.x).toBeCloseTo(-650);
    expect(v.y).toBeCloseTo(-170);
    fireEvent.pointerUp(b, { button: 0, clientX: 250, clientY: 330 });
    expect(b.style.cursor).toBe("grab");
    // 抬起后移动不再平移
    fireEvent.pointerMove(b, { buttons: 0, clientX: 100, clientY: 100 });
    expect(vp(container)!.x).toBeCloseTo(-650);

    // 主键已松开时到达的移动结束拖拽
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 0, clientX: 280, clientY: 300 });
    expect(b.style.cursor).toBe("grab");
    fireEvent.pointerMove(b, { buttons: 1, clientX: 260, clientY: 300 });
    expect(vp(container)!.x).toBeCloseTo(-650);

    // pointercancel 结束拖拽
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerCancel(b, {});
    fireEvent.pointerMove(b, { buttons: 1, clientX: 200, clientY: 300 });
    expect(vp(container)!.x).toBeCloseTo(-650);

    // 拖过头被夹住
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 1, clientX: 3000, clientY: 3000 });
    v = vp(container)!;
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    fireEvent.pointerUp(b, { button: 0 });

    // 非主键不拖
    fireEvent.pointerDown(b, { button: 2, buttons: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 2, clientX: 200, clientY: 200 });
    expect(vp(container)!.x).toBe(0);
  });

  it("双击在适应与 100% 之间切换", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    const b = box(container);
    fireEvent.doubleClick(b, { clientX: LEFT + 400, clientY: TOP + 300 });
    let v = vp(container)!;
    expect(v.scale).toBe(1);
    expect(v.x).toBeCloseTo(-600);
    fireEvent.doubleClick(b, { clientX: LEFT + 400, clientY: TOP + 300 });
    v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.4);
    // 按下到抬起移动不足 4 像素仍算单击
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 1, clientX: 303, clientY: 300 });
    fireEvent.pointerUp(b, { button: 0, clientX: 303, clientY: 300 });
    fireEvent.doubleClick(b, { clientX: 303, clientY: 300 });
    expect(vp(container)!.scale).toBe(1);
    // 拖动了 4 像素以上的那次不算双击
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(b, { buttons: 1, clientX: 310, clientY: 300 });
    fireEvent.pointerUp(b, { button: 0, clientX: 310, clientY: 300 });
    fireEvent.doubleClick(b, { clientX: 310, clientY: 300 });
    expect(vp(container)!.scale).toBe(1);
  });

  it("换图后回到适应窗口", () => {
    const { container, rerender } = render(<Stage id={1} preloader={preloader} />);
    act(() => api().actual());
    expect(vp(container)!.scale).toBe(1);
    rerender(<Stage id={2} preloader={preloader} />);
    expect(img(container).getAttribute("src")).toBe("glance://localhost/image/2?v=1-1");
    const v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.3);
    expect(v.x).toBeCloseTo(250);
    expect(v.y).toBeCloseTo(0);
    flush();
    expect(percent(container)).toBe("30%");
  });

  it("当前图的条目被移除后不再保留旧图", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    expect(img(container)).not.toBeNull();
    act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] }));
    expect(img(container)).toBeNull();
  });

  it("条目没有宽高时，图片 load 之后按自然尺寸适应", () => {
    const { container } = render(<Stage id={3} preloader={preloader} />);
    const el = img(container);
    expect(vp(container)).toBeNull();
    expect(el.style.visibility).toBe("hidden");
    flush();
    expect(percent(container)).toBeNull();
    // 尺寸未知时命令不出错也不生效
    act(() => api().zoomBy(2));
    expect(vp(container)).toBeNull();
    Object.defineProperty(el, "naturalWidth", { configurable: true, value: 400 });
    Object.defineProperty(el, "naturalHeight", { configurable: true, value: 200 });
    fireEvent.load(el);
    const v = vp(container)!;
    expect(v).toEqual({ x: 200, y: 200, scale: 1 });
    expect(el.style.visibility).toBe("");
    expect(el.style.width).toBe("400px");
    flush();
    expect(percent(container)).toBe("100%");
  });

  it("容器变小：适应状态下重新适应；已放大时保持倍率且位置合法", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    resizeTo(400, 300);
    let v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.2);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(50);

    act(() => api().actual());
    resizeTo(200, 150);
    v = vp(container)!;
    expect(v.scale).toBe(1);
    expect(v.x).toBeLessThanOrEqual(0);
    expect(v.x).toBeGreaterThanOrEqual(200 - 2000);
    expect(v.y).toBeLessThanOrEqual(0);
    expect(v.y).toBeGreaterThanOrEqual(150 - 1000);
    expect([v.x, v.y, v.scale].every(Number.isFinite)).toBe(true);
  });

  it("+ - 0 1 四个命令生效", () => {
    act(() => useNav.getState().openSingle(1));
    const off = registerSingleCommands();
    window.addEventListener("keydown", handleKeyDown);
    try {
      const { container } = render(<Stage id={1} preloader={preloader} />);
      const press = (key: string, shiftKey = false) => act(() => void fireEvent.keyDown(document.body, { key, shiftKey }));
      press("+", true);
      expect(vp(container)!.scale).toBeCloseTo(0.5);
      press("=");
      expect(vp(container)!.scale).toBeCloseTo(0.625);
      press("-");
      expect(vp(container)!.scale).toBeCloseTo(0.5);
      press("1");
      expect(vp(container)!.scale).toBe(1);
      // 以容器中心为准
      expect(vp(container)!.x).toBeCloseTo(-600);
      press("0");
      expect(vp(container)!.scale).toBeCloseTo(0.4);
    } finally {
      window.removeEventListener("keydown", handleKeyDown);
      off();
    }
  });

  it("尺寸未知时换图与换元素同时发生：自然尺寸取自新元素", () => {
    // 已加载完成的图片元素（预加载器交来的那种）
    const loaded = (w: number, h: number) => {
      const el = document.createElement("img");
      Object.defineProperty(el, "complete", { configurable: true, value: true });
      Object.defineProperty(el, "naturalWidth", { configurable: true, value: w });
      Object.defineProperty(el, "naturalHeight", { configurable: true, value: h });
      return el;
    };
    function Harness({ el, imageKey }: { el: HTMLImageElement; imageKey: string }) {
      const [b, setB] = useState<HTMLDivElement | null>(null);
      useLayoutEffect(() => {
        b?.replaceChildren(el);
      }, [b, el]);
      useStageViewport({ box: b, img: el, size: null, imageKey });
      return <div ref={setB} />;
    }
    const a = loaded(400, 200);
    const { rerender } = render(<Harness el={a} imageKey="a" />);
    expect(a.style.width).toBe("400px");
    const b = loaded(1600, 600);
    rerender(<Harness el={b} imageKey="b" />);
    expect(b.style.width).toBe("1600px");
    expect(b.style.height).toBe("600px");
    // 800 / 1600 = 0.5
    expect(b.style.transform).toBe("translate(0px, 150px) scale(0.5)");
  });

  it("切图耗时在新内容提交后的第二帧记录：只走一帧不记", () => {
    // 先让挂载时排下的帧走完，免得与下面的样本混在一起
    const { rerender } = render(<Stage id={1} preloader={preloader} />);
    flush();
    flush();
    const before = switchStats().count;
    markSwitchStart();
    rerender(<Stage id={2} preloader={preloader} />);
    flush();
    expect(switchStats().count).toBe(before);
    flush();
    expect(switchStats().count).toBe(before + 1);
  });

  it("垫底的缩略图加载完成后才开始数帧", () => {
    useThumbs.getState().reset();
    act(() => useThumbs.getState().markReady([{ id: 1, v: "1-1" }], 320));
    // 什么都没预解码：只能垫缩略图
    const empty = new Preloader();
    const before = switchStats().count;
    markSwitchStart();
    const { container } = render(<Stage id={1} preloader={empty} />);
    const under = container.querySelector(".stage-underlay") as HTMLImageElement;
    expect(under).not.toBeNull();
    expect(under.complete).toBe(false);
    flush();
    flush();
    flush();
    expect(switchStats().count).toBe(before);
    fireEvent.load(under);
    flush();
    expect(switchStats().count).toBe(before);
    flush();
    expect(switchStats().count).toBe(before + 1);
  });

  it("解码好的原图按它自己的自然尺寸铺放，不按条目的宽高", () => {
    const loaded = preloader.get(1, url(1));
    if (loaded?.state !== "ready") throw new Error("1 should be ready");
    Object.defineProperty(loaded.img, "naturalWidth", { configurable: true, value: 1000 });
    Object.defineProperty(loaded.img, "naturalHeight", { configurable: true, value: 2000 });
    const { container } = render(<Stage id={1} preloader={preloader} />);
    expect(img(container).style.width).toBe("1000px");
    expect(img(container).style.height).toBe("2000px");
    // 800×600 里适应 1000×2000：0.3，横向居中
    const v = vp(container)!;
    expect(v.scale).toBeCloseTo(0.3);
    expect(v.x).toBeCloseTo(250);
    expect(v.y).toBeCloseTo(0);
  });

  it("卸载后清除命令用的接口", () => {
    const { unmount } = render(<Stage id={1} preloader={preloader} />);
    expect(useStageApi.getState().api).not.toBeNull();
    unmount();
    expect(useStageApi.getState().api).toBeNull();
  });
});

describe("useStageViewport 单击", () => {
  // 2000×1000 的图在 800×600 里适应：0.4 倍，纵向偏移 100
  function setup() {
    const onTap = vi.fn();
    const el = document.createElement("img");
    let api: StageApi | null = null;
    function Harness() {
      const [b, setB] = useState<HTMLDivElement | null>(null);
      useLayoutEffect(() => {
        b?.replaceChildren(el);
      }, [b]);
      api = useStageViewport({ box: b, img: el, size: { w: 2000, h: 1000 }, imageKey: "a", onTap }).api;
      return <div className="box" ref={setB} />;
    }
    const { container } = render(<Harness />);
    const b = container.querySelector(".box") as HTMLElement;
    const click = (x: number, y: number, to = { x, y }, button = 0) => {
      fireEvent.pointerDown(b, { button, buttons: button === 0 ? 1 : 2, clientX: x, clientY: y });
      fireEvent.pointerMove(b, { buttons: button === 0 ? 1 : 2, clientX: to.x, clientY: to.y });
      fireEvent.pointerUp(b, { button, clientX: to.x, clientY: to.y });
    };
    return { onTap, el, b, click, api: () => api! };
  }

  it("按下到抬起移动不足 4 像素：以图片坐标回调", () => {
    const { onTap, click } = setup();
    click(LEFT + 40, TOP + 102, { x: LEFT + 42, y: TOP + 103 });
    expect(onTap).toHaveBeenCalledTimes(1);
    const [ix, iy] = onTap.mock.calls[0];
    expect(ix).toBeCloseTo(105);
    expect(iy).toBeCloseTo(7.5);
  });

  it("拖动 4 像素以上不回调，照常平移", () => {
    const { onTap, el, click, api } = setup();
    act(() => api().actual());
    expect(el.style.transform).toBe("translate(-600px, -200px) scale(1)");
    click(300, 300, { x: 310, y: 300 });
    expect(onTap).not.toHaveBeenCalled();
    expect(el.style.transform).toBe("translate(-590px, -200px) scale(1)");
    // 放大后单击：仍回调，位置不变
    click(LEFT + 10, TOP + 20);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0][0]).toBeCloseTo(600);
    expect(onTap.mock.calls[0][1]).toBeCloseTo(220);
    expect(el.style.transform).toBe("translate(-590px, -200px) scale(1)");
  });

  it("点在图片之外、非主键、指针取消都不回调", () => {
    const { onTap, b, click } = setup();
    click(LEFT + 40, TOP + 50); // 图片上方的留白
    click(LEFT + 40, TOP + 102, undefined, 2);
    fireEvent.pointerDown(b, { button: 0, buttons: 1, clientX: LEFT + 40, clientY: TOP + 102 });
    fireEvent.pointerCancel(b, {});
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe("Stage 去背景吸管", () => {
  const initial = useEditUi.getState();
  const pick = vi.fn(async () => {});
  const editing = (o: { tab?: "removeBg" | "compress"; mode?: "color" | "alpha" } = {}) => {
    act(() =>
      useEditUi.setState({
        status: "ready",
        id: 1,
        tab: o.tab ?? "removeBg",
        opened: { session: 1, width: 4000, height: 2000, proxyW: 2000, proxyH: 1000, srcFormat: "png", hasAlpha: true, fileSize: 1 },
        removeBg: { ...initial.removeBg, mode: o.mode ?? "color" },
        pick,
      }),
    );
  };
  // 图片坐标 (ix, iy) 在容器里的客户端坐标：0.4 倍，纵向偏移 100
  const at = (ix: number, iy: number) => ({ clientX: LEFT + ix * 0.4, clientY: TOP + 100 + iy * 0.4 });
  const tap = (c: HTMLElement, ix: number, iy: number) => {
    const p = at(ix, iy);
    fireEvent.pointerDown(box(c), { button: 0, buttons: 1, ...p });
    fireEvent.pointerUp(box(c), { button: 0, ...p });
  };
  beforeEach(() => pick.mockClear());
  afterEach(() => act(() => useEditUi.setState(initial, true)));

  it("按颜色方式下单击舞台：按 opened 尺寸换算后取色", () => {
    editing();
    const { container } = render(<Stage id={1} preloader={preloader} />);
    expect(box(container).classList.contains("is-picking")).toBe(true);
    // 显示 2000×1000、opened 4000×2000：(10.6, 5.6) → (21.2, 11.2) → (21, 11)
    tap(container, 10.6, 5.6);
    expect(pick).toHaveBeenCalledWith(21, 11);
    // 最后一个像素
    tap(container, 1999.9, 999.9);
    expect(pick).toHaveBeenLastCalledWith(3999, 1999);
    // 图片之外不取
    pick.mockClear();
    tap(container, 100, -10);
    expect(pick).not.toHaveBeenCalled();
  });

  it("alpha 方式与其他页签不取色，也不显示吸管", () => {
    editing({ mode: "alpha" });
    const { container } = render(<Stage id={1} preloader={preloader} />);
    expect(box(container).classList.contains("is-picking")).toBe(false);
    tap(container, 10, 5);
    act(() => useEditUi.setState({ tab: "compress", removeBg: { ...initial.removeBg, mode: "color" } }));
    expect(box(container).classList.contains("is-picking")).toBe(false);
    tap(container, 10, 5);
    expect(pick).not.toHaveBeenCalled();
  });

  it("不在编辑中不取色", () => {
    const { container } = render(<Stage id={1} preloader={preloader} />);
    tap(container, 10, 5);
    expect(box(container).classList.contains("is-picking")).toBe(false);
    expect(pick).not.toHaveBeenCalled();
  });
});
