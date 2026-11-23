import { beforeEach, describe, expect, it } from "vitest";
import { useThumbs } from "./thumbs";

beforeEach(() => useThumbs.getState().reset());

const ready = () => useThumbs.getState().ready;

describe("thumbs store", () => {
  it("记录就绪档位，高档不被低档覆盖", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 640, v: "1-10" });
    s.apply({ type: "ready", id: 1, tier: 320, v: "1-10" });
    s.markReady([{ id: 2, v: "2-10" }, { id: 3, v: "3-10" }], 320);
    const r = ready();
    expect([r.get(1), r.get(2), r.get(3)]).toEqual([
      { tier: 640, v: "1-10" },
      { tier: 320, v: "2-10" },
      { tier: 320, v: "3-10" },
    ]);
  });
  it("同一档位下版本不同会替换", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 320, v: "1-10" });
    s.apply({ type: "ready", id: 1, tier: 320, v: "2-12" });
    expect(ready().get(1)).toEqual({ tier: 320, v: "2-12" });
  });
  it("版本不同时低档位也会替换（旧版本的高档图不能留着）", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 640, v: "1-10" });
    s.apply({ type: "ready", id: 1, tier: 320, v: "2-12" });
    expect(ready().get(1)).toEqual({ tier: 320, v: "2-12" });
  });
  it("版本相同且档位不更高时状态对象不变", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 640, v: "1-10" });
    const before = ready();
    s.apply({ type: "ready", id: 1, tier: 640, v: "1-10" });
    s.apply({ type: "ready", id: 1, tier: 320, v: "1-10" });
    s.markReady([{ id: 1, v: "1-10" }], 320);
    expect(ready()).toBe(before);
  });
  it("记录损坏", () => {
    useThumbs.getState().apply({ type: "broken", id: 5 });
    expect(useThumbs.getState().broken.has(5)).toBe(true);
  });
  it("forget 只清除损坏标记，保留就绪状态", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 320, v: "1-10" });
    s.apply({ type: "broken", id: 1 });
    s.apply({ type: "broken", id: 2 });
    s.forget([1]);
    const st = useThumbs.getState();
    expect(st.broken.has(1)).toBe(false);
    expect(st.broken.has(2)).toBe(true);
    expect(st.ready.get(1)).toEqual({ tier: 320, v: "1-10" });
  });
});
