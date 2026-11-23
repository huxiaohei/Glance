import { beforeEach, describe, expect, it } from "vitest";
import { createThumbBatcher } from "./thumbBatcher";
import { useThumbs } from "./thumbs";

beforeEach(() => useThumbs.getState().reset());

function fakeScheduler() {
  const queue: (() => void)[] = [];
  return { schedule: (cb: () => void) => void queue.push(cb), frame: () => queue.splice(0).forEach((cb) => cb()), queue };
}

describe("createThumbBatcher", () => {
  it("同一帧内的 N 个事件只更新一次 store，且高档位胜出", () => {
    const sch = fakeScheduler();
    let updates = 0;
    const unsub = useThumbs.subscribe(() => updates++);
    const batcher = createThumbBatcher((es) => useThumbs.getState().applyMany(es), sch.schedule);
    for (let i = 1; i <= 100; i++) batcher.push({ type: "ready", id: i, tier: 320, v: "1-1" });
    batcher.push({ type: "ready", id: 1, tier: 640, v: "1-1" });
    batcher.push({ type: "ready", id: 1, tier: 320, v: "1-1" });
    batcher.push({ type: "broken", id: 200 });
    expect(sch.queue.length).toBe(1);
    expect(updates).toBe(0);
    sch.frame();
    expect(updates).toBe(1);
    const s = useThumbs.getState();
    expect(s.ready.size).toBe(100);
    expect(s.ready.get(1)).toEqual({ tier: 640, v: "1-1" });
    expect(s.broken.has(200)).toBe(true);
    unsub();
  });

  it("下一帧的事件另起一次更新", () => {
    const sch = fakeScheduler();
    const batches: number[] = [];
    const batcher = createThumbBatcher((es) => batches.push(es.length), sch.schedule);
    batcher.push({ type: "broken", id: 1 });
    sch.frame();
    batcher.push({ type: "broken", id: 2 });
    batcher.push({ type: "broken", id: 3 });
    sch.frame();
    expect(batches).toEqual([1, 2]);
  });
});
