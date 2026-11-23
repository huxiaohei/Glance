// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { t } from "../../i18n";
import { thumbsSubscribe, thumbsWant } from "../../ipc/api";
import { switchStats } from "../../lib/perfMarks";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

let restore: (() => void)[] = [];
const stubProp = (proto: object, prop: string, desc: PropertyDescriptor) => {
  const old = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, ...desc });
  restore.push(() => (old ? Object.defineProperty(proto, prop, old) : delete (proto as Record<string, unknown>)[prop]));
};

// 每次 decode() 记下图片与当时的地址，由测试手动 resolve / reject
interface Decode { url: string; img: HTMLImageElement; resolve: () => void; reject: () => void }
let decodes: Decode[] = [];

beforeEach(() => {
  decodes = [];
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(thumbsWant).mockResolvedValue([]);
  stubProp(Element.prototype, "clientWidth", { get: () => 800 });
  stubProp(Element.prototype, "clientHeight", { get: () => 600 });
  stubProp(HTMLImageElement.prototype, "decode", {
    value(this: HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        decodes.push({ url: this.src, img: this, resolve, reject: () => reject(new Error("decode failed")) });
      });
    },
  });
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
});
afterEach(() => {
  vi.useRealTimers();
  for (const r of restore.reverse()) r();
  restore = [];
});

const url = (id: number) => `glance://localhost/image/${id}?v=1-1`;

/** 打开目录并加入条目；dirs 给出各 id 的所在目录（默认根目录），尺寸统一 2000×1000。 */
function setup(ids: number[], dirs: Record<number, string> = {}) {
  const view = render(<App />);
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: ids.map((id) => ({
        id,
        relPath: dirs[id] ? `${dirs[id]}/${String(id).padStart(2, "0")}.jpg` : `${String(id).padStart(2, "0")}.jpg`,
        size: 1,
        mtimeMs: 1,
      })),
    });
    useCatalog.getState().apply({ type: "dims", generation: 1, items: ids.map((id) => ({ id, w: 2000, h: 1000 })) });
  });
  return view.container;
}
const openAt = (id: number) => act(() => useNav.getState().openSingle(id));
const key = (k: string, o: Partial<KeyboardEventInit> = {}) => {
  act(() => {
    fireEvent.keyDown(document.body, { key: k, ...o });
  });
};
const live = (id: number) => decodes.filter((d) => d.url === url(id));
async function decodeOk(...ids: number[]) {
  await act(async () => {
    for (const id of ids) for (const d of live(id)) d.resolve();
  });
}
async function decodeFail(id: number) {
  await act(async () => {
    for (const d of live(id)) d.reject();
  });
  // 加载也失败
  act(() => {
    for (const d of live(id)) fireEvent.error(d.img);
  });
}
const shown = (c: HTMLElement) => [...c.querySelectorAll(".stage img")].map((i) => i.getAttribute("src"));
const hint = (c: HTMLElement) => c.querySelector(".single-hint")?.textContent ?? null;
const current = () => {
  const v = topView();
  return v.kind === "single" ? v.id : null;
};

describe("单张视图切图", () => {
  it("右键切到下一张；到最后一张再按显示“已是最后一张”且不循环", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = setup([1, 2, 3]);
    openAt(1);
    await decodeOk(1, 2, 3);
    expect(shown(c)).toEqual([url(1)]);

    key("ArrowLeft");
    expect(current()).toBe(1);
    expect(hint(c)).toBe(t("hint.first"));

    key("ArrowRight");
    expect(current()).toBe(2);
    // 已预解码：立即换上
    expect(shown(c)).toEqual([url(2)]);
    // 按住不放的自动重复同样切图
    key("ArrowRight", { repeat: true });
    expect(current()).toBe(3);
    expect(shown(c)).toEqual([url(3)]);

    key("ArrowRight");
    expect(current()).toBe(3);
    expect(hint(c)).toBe(t("hint.last"));
    // 1.5 秒后消失；连续触发时重新计时
    act(() => vi.advanceTimersByTime(1000));
    key("ArrowRight", { repeat: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(hint(c)).toBe(t("hint.last"));
    act(() => vi.advanceTimersByTime(600));
    expect(hint(c)).toBeNull();
  });

  it("跨分组时提示新目录名", async () => {
    const c = setup([1, 2, 3, 4], { 2: "a", 3: "a", 4: "a/b" });
    openAt(1);
    key("ArrowRight");
    expect(current()).toBe(2);
    expect(hint(c)).toBe("a");
    key("ArrowRight");
    expect(current()).toBe(3);
    // 同组内不提示新的目录名（保留上一条直到消失）
    expect(hint(c)).toBe("a");
    key("ArrowRight");
    expect(hint(c)).toBe("a/b");
    key("Home");
    expect(current()).toBe(1);
    expect(hint(c)).toBe(t("grid.rootGroup"));
  });

  it("Home / End 跳到第一张和最后一张", async () => {
    const c = setup([1, 2, 3, 4, 5]);
    openAt(3);
    await decodeOk(3);
    const before = switchStats().count;
    key("End");
    expect(current()).toBe(5);
    key("End");
    expect(hint(c)).toBe(t("hint.last"));
    key("Home");
    expect(current()).toBe(1);
    key("Home");
    expect(hint(c)).toBe(t("hint.first"));
    // 换上新图后的下一帧记录切图耗时（不换图的 Home/End 不计）
    await decodeOk(1);
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(switchStats().count).toBe(before + 1);
  });

  it("当前图未解码时先显示缩略图，解码完成后换成原图", async () => {
    const c = setup([1, 2, 3, 4]);
    act(() => useThumbs.getState().markReady([{ id: 2, v: "1-1" }], 320));
    openAt(1);
    await decodeOk(1);
    const full1 = c.querySelector(".stage img") as HTMLImageElement;
    const transform1 = full1.style.transform;

    key("ArrowRight");
    // 旧图不留在画面上，只有新图的缩略图，按原图像素尺寸与同一变换铺放
    expect(shown(c)).toEqual(["glance://localhost/thumb/2/320?v=1-1"]);
    const under = c.querySelector(".stage img") as HTMLImageElement;
    expect(under.classList.contains("stage-underlay")).toBe(true);
    expect(under.style.width).toBe("2000px");
    expect(under.style.height).toBe("1000px");
    expect(under.style.transform).toBe(transform1);

    await decodeOk(2);
    expect(shown(c)).toEqual([url(2)]);
    expect((c.querySelector(".stage img") as HTMLImageElement).style.transform).toBe(transform1);

    // 没有就绪缩略图时画面为空，不显示上一张
    key("ArrowRight");
    expect(current()).toBe(3);
    expect(shown(c)).toEqual([]);
  });

  it("快速连切：先完成的旧图解码不会被显示", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const c = setup(ids);
    openAt(1);
    await decodeOk(1);
    for (let i = 0; i < 5; i++) key("ArrowRight", { repeat: i > 0 });
    expect(current()).toBe(6);
    // 滚过去的预加载被丢弃（src 清空），只保留当前附近的
    for (const id of [2, 3]) expect(live(id).every((d) => d.img.getAttribute("src") === "")).toBe(true);
    const alive = new Set(decodes.filter((d) => d.img.getAttribute("src")).map((d) => d.url));
    expect(alive).toEqual(new Set([4, 5, 6, 7, 8].map(url)));

    // 旧图先完成解码：不显示
    await decodeOk(2, 3, 4, 5);
    expect(shown(c)).toEqual([]);
    await decodeOk(6);
    expect(shown(c)).toEqual([url(6)]);
    // 往回切到已解码的 5：立即换上
    key("ArrowLeft");
    expect(shown(c)).toEqual([url(5)]);
  });

  it("解码失败显示占位，仍可继续切换", async () => {
    const c = setup([1, 2, 3]);
    openAt(1);
    await decodeOk(1);
    key("ArrowRight");
    await decodeFail(2);
    expect(shown(c)).toEqual([]);
    expect(c.querySelector(".stage-unreadable")?.textContent).toBe(t("grid.unreadable"));
    key("ArrowRight");
    expect(current()).toBe(3);
    expect(c.querySelector(".stage-unreadable")).toBeNull();
    await decodeOk(3);
    expect(shown(c)).toEqual([url(3)]);
  });

  it("点击右侧箭头区域切到下一张；最后一张时右侧箭头不出现", async () => {
    const c = setup([1, 2, 3]);
    openAt(1);
    expect(c.querySelector(".stage-arrow-left")).toBeNull();
    fireEvent.click(c.querySelector(".stage-arrow-right")!);
    expect(current()).toBe(2);
    await decodeOk(2);
    const before = (c.querySelector(".stage img") as HTMLImageElement).style.transform;
    // 箭头区域上的双击不切换缩放
    const left = c.querySelector(".stage-arrow-left")!;
    fireEvent.pointerDown(left, { button: 0, buttons: 1 });
    fireEvent.pointerUp(left, { button: 0 });
    fireEvent.doubleClick(left);
    expect((c.querySelector(".stage img") as HTMLImageElement).style.transform).toBe(before);

    fireEvent.click(c.querySelector(".stage-arrow-right")!);
    expect(current()).toBe(3);
    expect(c.querySelector(".stage-arrow-right")).toBeNull();
    fireEvent.click(c.querySelector(".stage-arrow-left")!);
    expect(current()).toBe(2);
  });
});
