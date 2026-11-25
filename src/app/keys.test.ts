import { describe, expect, it } from "vitest";
import { detectMac, formatKey, matchKey, type KeyLike } from "./keys";

const ev = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o,
});

describe("detectMac", () => {
  it("platform 为空串时退回 userAgent", () => {
    expect(detectMac({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" })).toBe(true);
    expect(detectMac({ platform: "MacIntel", userAgent: "" })).toBe(true);
    expect(detectMac({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe(false);
  });
});

describe("matchKey", () => {
  it("Mod 在 macOS 上是 Cmd，在其他平台是 Ctrl", () => {
    expect(matchKey(ev("a", { metaKey: true }), "Mod+A", true)).toBe(true);
    expect(matchKey(ev("a", { ctrlKey: true }), "Mod+A", true)).toBe(false);
    expect(matchKey(ev("a", { ctrlKey: true }), "Mod+A", false)).toBe(true);
    expect(matchKey(ev("a", { metaKey: true }), "Mod+A", false)).toBe(false);
  });
  it("macOS 上 Ctrl+A 不匹配 Mod+A，同时按 Ctrl 和 Cmd 也不匹配", () => {
    expect(matchKey(ev("a", { metaKey: true, ctrlKey: true }), "Mod+A", true)).toBe(false);
  });
  it("字母不分大小写；多按了 Shift 不匹配 Mod+A", () => {
    expect(matchKey(ev("A", { metaKey: true }), "Mod+a", true)).toBe(true);
    expect(matchKey(ev("A", { metaKey: true, shiftKey: true }), "Mod+A", true)).toBe(false);
  });
  it("“?” 不比较 Shift", () => {
    expect(matchKey(ev("?", { shiftKey: true }), "?", true)).toBe(true);
    expect(matchKey(ev("?"), "?", true)).toBe(true);
    expect(matchKey(ev("?", { metaKey: true }), "?", true)).toBe(false);
  });
  it("Shift+ArrowLeft 要求按着 Shift", () => {
    expect(matchKey(ev("ArrowLeft", { shiftKey: true }), "Shift+ArrowLeft", true)).toBe(true);
    expect(matchKey(ev("ArrowLeft"), "Shift+ArrowLeft", true)).toBe(false);
    expect(matchKey(ev("ArrowLeft", { shiftKey: true }), "ArrowLeft", true)).toBe(false);
  });
  it("Tab、F5 等命名键精确匹配", () => {
    expect(matchKey(ev("Tab"), "Tab", false)).toBe(true);
    expect(matchKey(ev("F5"), "F5", false)).toBe(true);
    expect(matchKey(ev("F5", { altKey: true }), "F5", false)).toBe(false);
  });
});

describe("formatKey", () => {
  it("Mod+A：mac 上 ⌘A，Windows 上 Ctrl+A", () => {
    expect(formatKey("Mod+A", true)).toBe("⌘A");
    expect(formatKey("Mod+A", false)).toBe("Ctrl+A");
  });
  it("Shift+ArrowLeft：⇧← / Shift+←", () => {
    expect(formatKey("Shift+ArrowLeft", true)).toBe("⇧←");
    expect(formatKey("Shift+ArrowLeft", false)).toBe("Shift+←");
  });
  it("F5、? 原样显示", () => {
    expect(formatKey("F5", true)).toBe("F5");
    expect(formatKey("?", false)).toBe("?");
  });
  it("Backspace 各平台都是 ⌫；Delete 在 macOS 上是 ⌦，其他平台 Del", () => {
    expect(formatKey("Mod+Backspace", true)).toBe("⌘⌫");
    expect(formatKey("Backspace", false)).toBe("⌫");
    expect(formatKey("Mod+Delete", true)).toBe("⌘⌦");
    expect(formatKey("Delete", false)).toBe("Del");
  });
});

describe("matchKey 带 Shift 的数字键", () => {
  it("Shift+1 匹配 key='!'、code='Digit1'、shift 按下", () => {
    expect(matchKey(ev("!", { shiftKey: true, code: "Digit1" }), "Shift+1", true)).toBe(true);
  });
  it("Shift+1 不匹配没按 Shift 的 1", () => {
    expect(matchKey(ev("1", { code: "Digit1" }), "Shift+1", true)).toBe(false);
  });
  it("1 不匹配按着 Shift 的 Digit1", () => {
    expect(matchKey(ev("!", { shiftKey: true, code: "Digit1" }), "1", true)).toBe(false);
  });
  it("没有 code 的事件不匹配 Shift+数字", () => {
    expect(matchKey(ev("!", { shiftKey: true }), "Shift+1", true)).toBe(false);
  });
});

describe("空格键", () => {
  it("Space 按 e.key 为 \" \" 匹配，显示为 Space", () => {
    expect(matchKey(ev(" "), " ", true)).toBe(true);
    expect(matchKey(ev(" ", { metaKey: true }), " ", true)).toBe(false);
    expect(formatKey(" ", true)).toBe("Space");
    expect(formatKey(" ", false)).toBe("Space");
  });
});
