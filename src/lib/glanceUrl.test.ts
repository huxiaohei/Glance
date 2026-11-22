import { expect, it } from "vitest";
import { glanceUrl } from "./glanceUrl";

it("macOS 用自定义协议形式", () => {
  expect(glanceUrl("image/42", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"))
    .toBe("glance://localhost/image/42");
});
it("Windows 用 http 子域形式", () => {
  expect(glanceUrl("image/42?v=1-2", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"))
    .toBe("http://glance.localhost/image/42?v=1-2");
});
