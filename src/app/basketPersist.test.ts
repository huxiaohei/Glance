// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoredItem } from "../ipc/types";
import { useBasket } from "../stores/basket";

const api = vi.hoisted(() => ({ basketSave: vi.fn(), basketRestore: vi.fn() }));
vi.mock("../ipc/api", () => api);

import { SAVE_DEBOUNCE_MS, startBasketPersist } from "./basketPersist";

const item = (id: number) => ({ id, name: `${id}.png`, dirName: "d", size: 1, mtimeMs: 1 });
const rest = (id: number): RestoredItem => ({ id, name: `${id}.png`, dirName: "d", entry: null });
const add = (...ids: number[]) => useBasket.getState().toggleItems(ids.map(item));
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

let stop: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  api.basketSave.mockReset().mockResolvedValue(undefined);
  api.basketRestore.mockReset().mockResolvedValue([]);
  useBasket.setState({ order: [], items: new Map(), missing: new Set() });
});
afterEach(() => { stop?.(); stop = null; vi.useRealTimers(); });

describe("basketPersist", () => {
  it("does not save before hydrate", async () => {
    api.basketRestore.mockReturnValue(new Promise(() => {}));
    stop = startBasketPersist();
    add(1);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(api.basketSave).not.toHaveBeenCalled();
  });
  it("restores then hydrates the store", async () => {
    api.basketRestore.mockResolvedValue([rest(3), rest(4)]);
    stop = startBasketPersist();
    await flush();
    expect(useBasket.getState().order).toEqual([3, 4]);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(api.basketSave).not.toHaveBeenCalled();
  });
  it("saves debounced after change", async () => {
    stop = startBasketPersist();
    await flush();
    add(1);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    add(2);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(api.basketSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.basketSave).toHaveBeenCalledTimes(1);
    expect(api.basketSave).toHaveBeenCalledWith([1, 2]);
  });
  it("restore failure still enables saving", async () => {
    api.basketRestore.mockRejectedValue(new Error("x"));
    stop = startBasketPersist();
    await flush();
    add(7);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(api.basketSave).toHaveBeenCalledWith([7]);
  });
  it("pagehide flushes pending save", async () => {
    stop = startBasketPersist();
    await flush();
    add(1);
    window.dispatchEvent(new Event("pagehide"));
    expect(api.basketSave).toHaveBeenCalledWith([1]);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(api.basketSave).toHaveBeenCalledTimes(1);
  });
  it("stop clears timers and subscription", async () => {
    stop = startBasketPersist();
    await flush();
    add(1);
    stop();
    stop = null;
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    add(2);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(api.basketSave).not.toHaveBeenCalled();
  });
  it("serializes saves: second save waits for first, sends latest", async () => {
    let release!: () => void;
    api.basketSave.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    stop = startBasketPersist();
    await flush();
    add(1);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(api.basketSave).toHaveBeenCalledTimes(1);
    add(2);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    add(3);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(api.basketSave).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(api.basketSave).toHaveBeenCalledTimes(2);
    expect(api.basketSave).toHaveBeenLastCalledWith([1, 2, 3]);
  });
});
