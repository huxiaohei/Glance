import { describe, expect, it } from "vitest";
import { translate } from "./index";

describe("translate", () => {
  it("中文环境返回中文", () => {
    expect(translate("zh-CN", "app.openFolder")).toBe("打开目录");
  });
  it("其他语言回落到英文", () => {
    expect(translate("fr-FR", "app.openFolder")).toBe("Open Folder");
  });
});
