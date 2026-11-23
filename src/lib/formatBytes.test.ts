import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [5242880, "5.0 MB"],
    [3221225472, "3.0 GB"],
    [5 * 1024 ** 4, "5120.0 GB"],
  ])("formatBytes(%i)", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});
