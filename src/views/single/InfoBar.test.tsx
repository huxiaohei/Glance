// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { appVersion, basketRestore, onOpenRequest, takeOpenRequest, thumbsSubscribe, thumbsWant, updateCheck } from "../../ipc/api";
import { useCatalog } from "../../stores/catalog";
import { useListView } from "../../stores/listView";
import { useNav } from "../../stores/nav";
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
  vi.mocked(takeOpenRequest).mockResolvedValue(null);
  vi.mocked(basketRestore).mockResolvedValue([]);
  vi.mocked(updateCheck).mockResolvedValue(null);
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(onOpenRequest).mockResolvedValue(() => {});
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

describe("信息条的格式标签", () => {
  it("HEIF 与 HEIC 都显示 HEIC，AVIF 显示 AVIF，jpeg 显示 JPG", () => {
    const c = setup([
      { id: 1, relPath: "x.heif" },
      { id: 2, relPath: "x.HEIC" },
      { id: 3, relPath: "x.avif" },
      { id: 4, relPath: "x.jpeg" },
    ]);
    const label = (id: number) => {
      openAt(id);
      return q(c, ".single-infobar .info-format")!.textContent;
    };
    expect(label(1)).toBe("HEIC");
    expect(label(2)).toBe("HEIC");
    expect(label(3)).toBe("AVIF");
    expect(label(4)).toBe("JPG");
  });
});
