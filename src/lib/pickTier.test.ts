import { expect, it } from "vitest";
import { pickTier } from "./pickTier";

it("按物理像素选档", () => {
  expect(pickTier(160, 2)).toBe(320);
  expect(pickTier(161, 2)).toBe(640);
  expect(pickTier(320, 1)).toBe(320);
  expect(pickTier(320, 2)).toBe(640);
  expect(pickTier(96, 3)).toBe(320);
});
