import { describe, expect, it } from "vitest";
import { escapeMnemonic } from "./menuLabel";

describe("escapeMnemonic", () => {
  it("把每个 & 写成 &&，免得被当成助记符", () => {
    expect(escapeMnemonic("R&D")).toBe("R&&D");
    expect(escapeMnemonic("&a&&b&")).toBe("&&a&&&&b&&");
    expect(escapeMnemonic("普通目录")).toBe("普通目录");
  });
});
