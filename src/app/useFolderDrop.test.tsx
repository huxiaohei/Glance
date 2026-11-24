// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Payload =
  | { type: "enter" | "over"; paths?: string[]; position: { x: number; y: number } }
  | { type: "leave" }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } };
const hooks = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
  own: false,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (e: { payload: unknown }) => void) => {
      hooks.handler = h;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("./openFolder", () => ({ openFolder: vi.fn(() => Promise.resolve()) }));
vi.mock("./nativeDrag", () => ({ isOwnDragActive: () => hooks.own }));

const { useFolderDrop } = await import("./useFolderDrop");
const { openFolder } = await import("./openFolder");

const pos = { x: 10, y: 10 };
const send = (payload: Payload) => act(() => hooks.handler!({ payload }));

describe("useFolderDrop", () => {
  beforeEach(() => {
    hooks.handler = null;
    hooks.own = false;
    vi.mocked(openFolder).mockClear();
  });

  it("enter 显示描边，drop 打开第一个路径", async () => {
    const { result } = renderHook(() => useFolderDrop());
    await act(async () => {});
    send({ type: "enter", paths: ["/a"], position: pos });
    expect(result.current).toBe(true);
    send({ type: "drop", paths: ["/a", "/b"], position: pos });
    expect(result.current).toBe(false);
    expect(openFolder).toHaveBeenCalledWith("/a");
  });

  it("自己的拖拽进行中收到 enter / drop：不显示描边，不调用 openFolder", async () => {
    const { result } = renderHook(() => useFolderDrop());
    await act(async () => {});
    hooks.own = true;
    send({ type: "enter", paths: ["/a"], position: pos });
    expect(result.current).toBe(false);
    send({ type: "over", position: pos });
    expect(result.current).toBe(false);
    send({ type: "drop", paths: ["/a"], position: pos });
    expect(result.current).toBe(false);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("自己的拖拽开始前已有描边：leave 照样清掉", async () => {
    const { result } = renderHook(() => useFolderDrop());
    await act(async () => {});
    send({ type: "enter", paths: ["/a"], position: pos });
    expect(result.current).toBe(true);
    hooks.own = true;
    send({ type: "leave" });
    expect(result.current).toBe(false);
  });

  it("自己的拖拽结束后收到 drop：照常打开", async () => {
    const { result } = renderHook(() => useFolderDrop());
    await act(async () => {});
    hooks.own = true;
    send({ type: "drop", paths: ["/a"], position: pos });
    hooks.own = false;
    send({ type: "enter", paths: ["/b"], position: pos });
    expect(result.current).toBe(true);
    send({ type: "drop", paths: ["/b"], position: pos });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledWith("/b");
  });
});
