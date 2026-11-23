// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { imageDetails, thumbsSubscribe, thumbsWant } from "../../ipc/api";
import type { ImageDetails } from "../../ipc/types";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { useNav } from "../../stores/nav";
import { useSelection } from "../../stores/selection";
import { useSingleUi } from "../../stores/singleUi";
import { useThumbs } from "../../stores/thumbs";

vi.mock("../../ipc/api");
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

let restore: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(thumbsWant).mockResolvedValue([]);
  vi.mocked(imageDetails).mockReset();
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
    Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => 600 });
    restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
  }
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  restore.push(() =>
    d ? Object.defineProperty(HTMLImageElement.prototype, "decode", d) : delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode,
  );
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
  useSingleUi.setState({ infoOpen: false });
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  restore = [];
});

const details = (over: Partial<ImageDetails> = {}): ImageDetails => ({
  path: "/p/a.png",
  mtimeMs: 1,
  color: "RGBA",
  bitDepth: 8,
  hasAlpha: true,
  dpi: [72, 72],
  animated: false,
  exif: [{ key: "make", value: "Canon" }],
  ...over,
});

function setup() {
  const view = render(<App />);
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: [1, 2].map((id) => ({ id, relPath: `${id}.png`, size: 2048, mtimeMs: 1 })),
    });
    useCatalog.getState().apply({ type: "dims", generation: 1, items: [{ id: 1, w: 40, h: 30 }, { id: 2, w: 50, h: 20 }] });
  });
  act(() => useNav.getState().openSingle(1));
  return view.container;
}
const panel = (c: HTMLElement) => c.querySelector(".details-panel");
const press = (key: string) => act(() => void fireEvent.keyDown(document.body, { key }));
const flush = () => act(async () => {});

describe("详细信息面板", () => {
  it("按 I 展开面板并请求详情；再按收起", async () => {
    vi.mocked(imageDetails).mockResolvedValue(details());
    const c = setup();
    expect(panel(c)).toBeNull();
    press("i");
    await flush();
    expect(panel(c)).not.toBeNull();
    expect(imageDetails).toHaveBeenCalledWith(1);
    expect(panel(c)!.textContent).toContain("/p/a.png");
    expect(panel(c)!.textContent).toContain("40 × 30");
    expect(panel(c)!.textContent).toContain("RGBA · 8 bit");
    expect(panel(c)!.textContent).toContain("Canon");
    press("i");
    expect(panel(c)).toBeNull();
  });

  it("顶栏按钮切换面板并显示激活态", async () => {
    vi.mocked(imageDetails).mockResolvedValue(details());
    const c = setup();
    const btn = () => c.querySelector<HTMLButtonElement>(".topbar-info")!;
    expect(btn().classList.contains("active")).toBe(false);
    act(() => void fireEvent.click(btn()));
    await flush();
    expect(btn().classList.contains("active")).toBe(true);
    expect(panel(c)).not.toBeNull();
  });

  it("面板关着时不请求详情", async () => {
    vi.mocked(imageDetails).mockResolvedValue(details());
    setup();
    act(() => useNav.getState().setCurrent(2));
    await flush();
    expect(imageDetails).not.toHaveBeenCalled();
  });

  it("切图后面板保持展开，内容换成新图的", async () => {
    vi.mocked(imageDetails).mockImplementation(async (id) => details({ path: `/p/${id}.png` }));
    const c = setup();
    press("i");
    await flush();
    expect(panel(c)!.textContent).toContain("/p/1.png");
    act(() => useNav.getState().setCurrent(2));
    await flush();
    expect(panel(c)).not.toBeNull();
    expect(panel(c)!.textContent).toContain("/p/2.png");
    expect(panel(c)!.textContent).toContain("50 × 20");
  });

  it("迟到的应答不覆盖当前图的内容", async () => {
    const pending = new Map<number, (d: ImageDetails) => void>();
    vi.mocked(imageDetails).mockImplementation((id) => new Promise((r) => pending.set(id, r)));
    const c = setup();
    press("i");
    act(() => useNav.getState().setCurrent(2));
    await flush();
    await act(async () => pending.get(2)!(details({ path: "/p/2.png" })));
    await act(async () => pending.get(1)!(details({ path: "/p/1.png" })));
    expect(panel(c)!.textContent).toContain("/p/2.png");
    expect(panel(c)!.textContent).not.toContain("/p/1.png");
  });

  it("没有 EXIF 时不显示拍摄信息一组；缺失的行不显示", async () => {
    vi.mocked(imageDetails).mockResolvedValue(
      details({ exif: [], color: null, bitDepth: null, hasAlpha: null, dpi: null }),
    );
    const c = setup();
    press("i");
    await flush();
    expect(c.querySelectorAll(".details-group").length).toBe(2);
    const rows = c.querySelectorAll(".details-row").length;
    expect(rows).toBe(5); // 文件名、路径、大小、修改时间、宽×高
  });

  it("请求失败时显示“无法读取”，不抛错", async () => {
    vi.mocked(imageDetails).mockRejectedValue(new Error("boom"));
    const c = setup();
    press("i");
    await flush();
    expect(c.querySelector(".details-error")).not.toBeNull();
  });
});
