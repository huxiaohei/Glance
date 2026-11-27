import { describe, expect, it } from "vitest";
import { isScaledDown } from "./scaledDown";

const heic = (width?: number, height?: number) => ({ name: "a.heic", width, height });

describe("isScaledDown", () => {
  it("后端解码的格式：显示的长边小于条目长边，已缩小", () => {
    expect(isScaledDown(heic(12000, 9000), 8000, 6000)).toBe(true);
    expect(isScaledDown({ name: "a.AVIF", width: 9000, height: 12000 }, 6000, 8000)).toBe(true);
  });
  it("长边相等或更大：没有缩小", () => {
    expect(isScaledDown(heic(4000, 3000), 4000, 3000)).toBe(false);
    expect(isScaledDown(heic(4000, 3000), 4001, 3000)).toBe(false);
  });
  it("宽高互换但长边相同（方向、净孔径）：不算缩小", () => {
    expect(isScaledDown(heic(4000, 3000), 3000, 4000)).toBe(false);
  });
  it("浏览器自己解码的格式从不显示", () => {
    expect(isScaledDown({ name: "a.jpg", width: 12000, height: 9000 }, 8000, 6000)).toBe(false);
    // PNG / WebP 的 EXIF 方向浏览器不管、条目尺寸已换算：宽高互换也不能误报。
    expect(isScaledDown({ name: "a.png", width: 3000, height: 4000 }, 4000, 3000)).toBe(false);
  });
  it("条目尺寸未知，或还没有显示的图：不算缩小", () => {
    expect(isScaledDown(heic(), 8000, 6000)).toBe(false);
    expect(isScaledDown(heic(12000, 9000), 0, 0)).toBe(false);
  });
});
