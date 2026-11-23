// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbsWant } from "../../ipc/api";
import { layoutGrid, type GridLayout } from "../../lib/gridLayout";
import { useThumbs } from "../../stores/thumbs";
import { useVisibleThumbs } from "./useVisibleThumbs";

vi.mock("../../ipc/api", () => ({ thumbsWant: vi.fn() }));

const layout: GridLayout = layoutGrid(
  { ids: [1, 2, 3], groups: [{ dir: "", start: 0, count: 3, total: 3 }] },
  600,
  160,
);

describe("useVisibleThumbs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(thumbsWant).mockResolvedValue([]);
    useThumbs.getState().reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("去抖 50ms 后请求可见的 id，跳过已损坏的", async () => {
    useThumbs.setState({ broken: new Set([2]) });
    renderHook(() => useVisibleThumbs(layout, 0, 600, 320));
    expect(thumbsWant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(thumbsWant).toHaveBeenCalledWith("grid", [1, 3], 320);
  });

  it("后端回报已缓存的项后，按带版本的形状标记就绪", async () => {
    vi.mocked(thumbsWant).mockResolvedValue([{ id: 1, v: "5-10" }]);
    renderHook(() => useVisibleThumbs(layout, 0, 600, 320));
    await vi.advanceTimersByTimeAsync(50);
    expect(useThumbs.getState().ready.get(1)).toEqual({ tier: 320, v: "5-10" });
  });
});
