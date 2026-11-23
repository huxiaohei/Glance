import { afterEach, expect, it, vi } from "vitest";
import { glanceUrl, thumbKeyUrl } from "./glanceUrl";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("macOS 用自定义协议形式", () => {
  expect(glanceUrl("image/42", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"))
    .toBe("glance://localhost/image/42");
});
it("Windows 用 http 子域形式", () => {
  expect(glanceUrl("image/42?v=1-2", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"))
    .toBe("http://glance.localhost/image/42?v=1-2");
});

it("thumbKeyUrl 在 macOS 上是 glance://localhost/thumb-key/<key>，在 Windows 上是 http://glance.localhost/thumb-key/<key>", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  vi.stubGlobal("navigator", { userAgent: mac });
  expect(thumbKeyUrl(key)).toBe(`glance://localhost/thumb-key/${key}`);
  vi.stubGlobal("navigator", { userAgent: win });
  expect(thumbKeyUrl(key)).toBe(`http://glance.localhost/thumb-key/${key}`);
});
