import { describe, expect, it } from "vitest";
import { createSwitchTimer } from "./perfMarks";

describe("切图耗时", () => {
  it("统计 P50、P95、最大值；没有配对的 start 被忽略", () => {
    let now = 0;
    const tm = createSwitchTimer(() => now);
    expect(tm.switchStats()).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });

    // 没有 start 的 painted 不记
    tm.markSwitchPainted();
    expect(tm.switchStats().count).toBe(0);

    // 被后一次 start 取代的 start 不记，只算最后一次
    now = 0;
    tm.markSwitchStart();
    now = 500;
    tm.markSwitchStart();
    now = 510;
    tm.markSwitchPainted();
    // 已配对过的 painted 再来一次不记
    now = 900;
    tm.markSwitchPainted();
    expect(tm.switchStats()).toEqual({ count: 1, p50: 10, p95: 10, max: 10 });

    // 再记 1..99 共 100 个样本：10, 1, 2, ..., 99
    for (let d = 1; d <= 99; d++) {
      now = 1000 * d;
      tm.markSwitchStart();
      now += d;
      tm.markSwitchPainted();
    }
    const s = tm.switchStats();
    expect(s.count).toBe(100);
    expect(s.max).toBe(99);
    // 排序后 1..99 与 10：第 50 个是 49，第 95 个是 94
    expect(s.p50).toBe(49);
    expect(s.p95).toBe(94);
  });

  it("只保留最近 200 次", () => {
    let now = 0;
    const tm = createSwitchTimer(() => now);
    for (let i = 0; i < 250; i++) {
      tm.markSwitchStart();
      // 前 50 次耗时 1000，之后 5
      now += i < 50 ? 1000 : 5;
      tm.markSwitchPainted();
    }
    expect(tm.switchStats()).toEqual({ count: 200, p50: 5, p95: 5, max: 5 });
  });
});
