import { beforeEach, describe, expect, it } from "vitest";
import { useThumbs } from "./thumbs";

beforeEach(() => useThumbs.getState().reset());

describe("thumbs store", () => {
  it("记录就绪档位，高档不被低档覆盖", () => {
    const s = useThumbs.getState();
    s.apply({ type: "ready", id: 1, tier: 640 });
    s.apply({ type: "ready", id: 1, tier: 320 });
    s.markReady([2, 3], 320);
    const r = useThumbs.getState().ready;
    expect([r.get(1), r.get(2), r.get(3)]).toEqual([640, 320, 320]);
  });
  it("记录损坏", () => {
    useThumbs.getState().apply({ type: "broken", id: 5 });
    expect(useThumbs.getState().broken.has(5)).toBe(true);
  });
});
