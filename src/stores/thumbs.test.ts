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
  it("ready 清除损坏标记", () => {
    const s = useThumbs.getState();
    s.applyMany([{ type: "broken", id: 1 }, { type: "broken", id: 2 }, { type: "broken", id: 3 }]);
    s.applyMany([{ type: "ready", id: 1, tier: 320, v: "5-10" }]);
    s.markReady([{ id: 2, v: "5-10" }], 320);
    const st = useThumbs.getState();
    expect([st.broken.has(1), st.broken.has(2), st.broken.has(3)]).toEqual([false, false, true]);
    expect(st.ready.get(1)).toEqual({ tier: 320, v: "5-10" });
    expect(st.ready.get(2)).toEqual({ tier: 320, v: "5-10" });
    // 同一批里先 ready 后 broken：以后到的为准
    s.applyMany([{ type: "ready", id: 4, tier: 320, v: "1-1" }, { type: "broken", id: 4 }]);
    expect(useThumbs.getState().broken.has(4)).toBe(true);
  });
  it("修改时间更早的版本也会替换（Finder 替换、cp -p、解压会保留源文件的旧修改时间）", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 320, v: "2000-12" });
    s.apply({ type: "ready", id: 1, tier: 320, v: "1000-10" });
    expect(ready().get(1)).toEqual({ tier: 320, v: "1000-10" });
    s.markReady([{ id: 1, v: "500-10" }], 320);
    expect(ready().get(1)).toEqual({ tier: 320, v: "500-10" });
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
