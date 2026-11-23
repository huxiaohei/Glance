import { afterEach, describe, expect, it, vi } from "vitest";
import { locale, setLanguage, t, translate } from "./index";
import { en } from "./en";
import { zhCN } from "./zh-CN";

describe("translate", () => {
  it("中文环境返回中文", () => {
    expect(translate("zh-CN", "start.open")).toBe("打开目录");
  });
  it("其他语言回落到英文", () => {
    expect(translate("fr-FR", "start.open")).toBe("Open Folder");
  });
  it("替换 {n} 变量", () => {
    expect(translate("zh-CN", "grid.count", { n: 5 })).toBe("5 张");
    expect(translate("en-US", "grid.count", { n: 5 })).toBe("5");
  });
  it("缺少变量时保留占位符", () => {
    expect(translate("zh-CN", "grid.count")).toBe("{n} 张");
    expect(translate("zh-CN", "grid.count", {})).toBe("{n} 张");
  });
  it("两种语言的键一致", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });
});

describe("setLanguage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage("system");
  });
  it("setLanguage('en') 后 t() 取英文；'zh-CN' 后取中文", () => {
    setLanguage("en");
    expect(t("start.open")).toBe("Open Folder");
    setLanguage("zh-CN");
    expect(t("start.open")).toBe("打开目录");
  });
  it("setLanguage('system') 按 navigator.language 决定", () => {
    vi.stubGlobal("navigator", { language: "zh-TW" });
    setLanguage("system");
    expect(t("start.open")).toBe("打开目录");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(t("start.open")).toBe("Open Folder");
    expect(locale()).toBe("fr-FR");
  });
  it("locale() 返回生效的语言标签", () => {
    setLanguage("en");
    expect(locale()).toBe("en");
    setLanguage("zh-CN");
    expect(locale()).toBe("zh-CN");
  });
});
