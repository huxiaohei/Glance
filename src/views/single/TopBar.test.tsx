// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalog } from "../../stores/catalog";
import { useNav } from "../../stores/nav";
import { stopRename, useRename } from "../../stores/rename";
import TopBar from "./TopBar";

vi.mock("../../ipc/api");

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  stopRename();
  const c = useCatalog.getState();
  c.begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
  c.apply({ type: "batch", generation: 1, entries: [{ id: 1, relPath: "sub/赵云.png", size: 1, mtimeMs: 1 }] });
});

describe("TopBar 重命名", () => {
  it("重命名期间文件名处是输入框；双击文件名开始重命名", () => {
    const { container } = render(<TopBar id={1} />);
    expect(container.querySelector("input")).toBeNull();
    fireEvent.doubleClick(container.querySelector(".topbar-name")!);
    expect(useRename.getState().id).toBe(1);
    const input = container.querySelector(".topbar-path input") as HTMLInputElement;
    expect(input.value).toBe("赵云.png");
    expect(container.querySelector(".topbar-name")).toBeNull();
    act(() => stopRename());
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector(".topbar-name")!.textContent).toBe("赵云.png");
  });
});
