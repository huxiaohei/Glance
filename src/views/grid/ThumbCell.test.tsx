// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageEntry } from "../../lib/deriveList";
import { useThumbs } from "../../stores/thumbs";
import ThumbCell from "./ThumbCell";

const entry: ImageEntry = { id: 1, relPath: "a.jpg", dir: "", name: "a.jpg", size: 10, mtimeMs: 5 };

describe("ThumbCell", () => {
  beforeEach(() => useThumbs.getState().reset());

  it("地址里的版本来自就绪状态，而不是条目", () => {
    useThumbs.setState({ ready: new Map([[1, { tier: 320, v: "99-77" }]]) });
    const { container } = render(<ThumbCell entry={entry} cell={160} />);
    expect(container.querySelector("img")!.getAttribute("src")).toMatch(/thumb\/1\/320\?v=99-77$/);
  });

  it("缩略图加载失败后改显占位", () => {
    useThumbs.setState({ ready: new Map([[1, { tier: 320, v: "5-10" }]]) });
    const { container } = render(<ThumbCell entry={entry} cell={160} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".thumb-placeholder")).not.toBeNull();
  });
});
