// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { thumbsSubscribe, thumbsWant } from "../../ipc/api";
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
beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(thumbsWant).mockResolvedValue([]);
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
});
afterEach(() => {
  vi.useRealTimers();
  for (const r of restore.reverse()) r();
  restore = [];
});

interface Item { id: number; relPath: string; size?: number; dims?: [number, number] }
function setup(items: Item[]) {
  const view = render(<App />);
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: items.map((i) => ({ id: i.id, relPath: i.relPath, size: i.size ?? 1, mtimeMs: 1 })),
    });
    const dims = items.filter((i) => i.dims).map((i) => ({ id: i.id, w: i.dims![0], h: i.dims![1] }));
    if (dims.length) useCatalog.getState().apply({ type: "dims", generation: 1, items: dims });
  });
  return view.container;
}
const openAt = (id: number) => act(() => useNav.getState().openSingle(id));
const q = (c: HTMLElement, sel: string) => c.querySelector(sel);
const info = (c: HTMLElement) => q(c, ".single-infobar")?.textContent ?? "";

describe("信息条", () => {
  it("显示文件名、尺寸、大小、格式和序号", () => {
    const c = setup([
      { id: 1, relPath: "a.png" },
      { id: 2, relPath: "b.jpeg", size: 1536, dims: [4000, 3000] },
      { id: 3, relPath: "c.png" },
    ]);
    openAt(2);
    const bar = q(c, ".single-infobar")!;
    expect(q(c, ".single-infobar .info-name")!.textContent).toBe("b.jpeg");
    expect(bar.textContent).toContain("4000 × 3000");
    expect(bar.textContent).toContain("1.5 KB");
    expect(bar.textContent).toContain("JPG");
    expect(q(c, ".single-infobar .info-index")!.textContent).toBe("2 / 3");
  });

  it("尺寸未知时不显示尺寸，其余照常；没有扩展名时不显示格式", () => {
    const c = setup([{ id: 1, relPath: "noext", size: 2048 }]);
    openAt(1);
    expect(info(c)).not.toContain("×");
    expect(info(c)).toContain("noext");
    expect(info(c)).toContain("2.0 KB");
    expect(q(c, ".single-infobar .info-format")).toBeNull();
    expect(q(c, ".single-infobar .info-index")!.textContent).toBe("1 / 1");
  });

  it("宽或高为 0 时不显示尺寸，也不漏出字面的 0", () => {
    const c = setup([{ id: 1, relPath: "a.png", dims: [0, 100] }]);
    openAt(1);
    const bar = q(c, ".single-infobar")!;
    expect([...bar.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent === "0")).toBe(false);
    expect(q(c, ".single-infobar .info-dims")).toBeNull();
  });

  it("长文件名单行显示，完整名字在 title 里", () => {
    const long = `${"x".repeat(200)}.png`;
    const c = setup([{ id: 1, relPath: long }]);
    openAt(1);
    expect(q(c, ".single-infobar .info-name")!.getAttribute("title")).toBe(long);
  });
});

describe("顶栏", () => {
  it("根目录下的图只显示文件名", () => {
    const c = setup([{ id: 1, relPath: "a.png" }]);
    openAt(1);
    expect(q(c, ".single-topbar .topbar-dir")).toBeNull();
    expect(q(c, ".single-topbar .topbar-name")!.textContent).toBe("a.png");
  });

  it("子目录下的图显示“子目录 / 文件名”", () => {
    const c = setup([{ id: 1, relPath: "sub/a.png" }]);
    openAt(1);
    expect(q(c, ".single-topbar")!.textContent).toContain("sub");
    expect(q(c, ".single-topbar .topbar-name")!.textContent).toBe("a.png");
  });

  it("切到另一个子目录时目录名高亮，1 秒后恢复；同目录内切换不高亮", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = setup([
      { id: 1, relPath: "a/1.png" },
      { id: 2, relPath: "a/2.png" },
      { id: 3, relPath: "b/3.png" },
    ]);
    openAt(1);
    const hl = () => q(c, ".single-topbar .topbar-dir.dir-changed") !== null;
    expect(hl()).toBe(false); // 刚进入视图不算切换
    act(() => useNav.getState().setCurrent(2));
    expect(hl()).toBe(false); // 同目录
    act(() => useNav.getState().setCurrent(3));
    expect(hl()).toBe(true);
    act(() => void vi.advanceTimersByTime(999));
    expect(hl()).toBe(true);
    act(() => void vi.advanceTimersByTime(2));
    expect(hl()).toBe(false);
  });

  it("连续切换目录时重新计时", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = setup([
      { id: 1, relPath: "a/1.png" },
      { id: 2, relPath: "b/2.png" },
      { id: 3, relPath: "c/3.png" },
    ]);
    openAt(1);
    const hl = () => q(c, ".single-topbar .topbar-dir.dir-changed") !== null;
    act(() => useNav.getState().setCurrent(2));
    act(() => void vi.advanceTimersByTime(600));
    act(() => useNav.getState().setCurrent(3));
    act(() => void vi.advanceTimersByTime(600));
    expect(hl()).toBe(true);
    act(() => void vi.advanceTimersByTime(500));
    expect(hl()).toBe(false);
  });

  it("目录名一时取不到（条目暂缺）时高亮照常在 1 秒后消失", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = setup([
      { id: 1, relPath: "a/1.png" },
      { id: 2, relPath: "b/2.png" },
    ]);
    openAt(1);
    const hl = () => q(c, ".single-topbar .topbar-dir.dir-changed") !== null;
    act(() => useNav.getState().setCurrent(2));
    expect(hl()).toBe(true);
    // 当前项的条目一时不在（id 指向还没有条目的文件），随后又回来
    act(() => useNav.getState().setCurrent(99));
    act(() => useNav.getState().setCurrent(2));
    act(() => void vi.advanceTimersByTime(1001));
    expect(hl()).toBe(false);
  });

  it("点返回按钮回到网格，悬停提示带快捷键", () => {
    const c = setup([{ id: 1, relPath: "a.png" }]);
    openAt(1);
    const btn = q(c, ".single-topbar button.topbar-back") as HTMLButtonElement;
    expect(btn.getAttribute("title")).toContain("Escape");
    fireEvent.click(btn);
    expect(topView().kind).toBe("grid");
  });
});
