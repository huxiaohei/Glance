// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HeicLab, { dimsMismatch } from "./HeicLab";
import type { HeicProbe } from "./labApi";

const probes: Record<string, HeicProbe> = {
  "ok.heic": {
    readMs: 1, decodeMs: 2, encodeMs: 3, pngBytes: 100, width: 640, height: 480,
    headerDims: [640, 480], hasIcc: true,
  },
  "rotated.heic": {
    readMs: 1, decodeMs: 2, encodeMs: 3, pngBytes: 100, width: 480, height: 640,
    headerDims: [640, 480], hasIcc: false,
  },
};

vi.mock("./labApi", () => ({
  isHeifName: (n: string) => /\.(heic|avif)$/i.test(n),
  pickDir: vi.fn(async () => "/samples"),
  registerDir: vi.fn(async () => [
    { id: 1, name: "ok.heic", size: 10 },
    { id: 2, name: "rotated.heic", size: 20 },
    { id: 3, name: "note.txt", size: 1 },
  ]),
  heicProbe: vi.fn(async (path: string) => probes[path.split("/").pop()!]),
}));

afterEach(cleanup);

describe("HeicLab", () => {
  it("只列 HEIF 文件，宽高与文件头不符的行加高亮类", async () => {
    render(<HeicLab />);
    fireEvent.click(screen.getByText("选择目录"));
    await waitFor(() => expect(screen.getByText("rotated.heic")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText("640×480").length).toBeGreaterThan(1));
    expect(screen.queryByText("note.txt")).toBeNull();
    const bad = screen.getByText("rotated.heic").closest("tr")!;
    const good = screen.getByText("ok.heic").closest("tr")!;
    expect(bad.className).toContain("lab-mismatch");
    expect(good.className).not.toContain("lab-mismatch");
    expect(screen.getByText("480×640")).toBeTruthy();
  });

  it("dimsMismatch：超过显示上限时按比例比较", () => {
    const base = { readMs: 0, decodeMs: 0, encodeMs: 0, pngBytes: 0, hasIcc: false };
    expect(dimsMismatch({ ...base, width: 8000, height: 6000, headerDims: [12000, 9000] })).toBe(false);
    expect(dimsMismatch({ ...base, width: 6000, height: 8000, headerDims: [12000, 9000] })).toBe(true);
    expect(dimsMismatch({ ...base, width: 1, height: 1, headerDims: null })).toBe(false);
  });
});
