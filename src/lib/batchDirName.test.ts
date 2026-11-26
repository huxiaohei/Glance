import { describe, expect, it } from "vitest";
import { validBatchDirName } from "./batchDirName";

describe("validBatchDirName", () => {
  it("合法名", () => {
    for (const n of ["_glance_output", "out", "  out  ", "a".repeat(64), "赵云 输出"]) {
      expect(validBatchDirName(n), n).toBe(true);
    }
  });
  it("非法名", () => {
    for (const n of ["a/b", "a\\b", "a:b", ".x", "", "   ", "CON", "con.x", "COM1", "lpt9", "a.", "a<b", "a|b", 'a"b', "a?b", "a*b", "a\u0001b", "a".repeat(65)]) {
      expect(validBatchDirName(n), n).toBe(false);
    }
  });
});
