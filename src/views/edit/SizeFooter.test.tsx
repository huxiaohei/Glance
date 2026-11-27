// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EditOpened, SrcFormat } from "../../ipc/types";
import { useEditUi } from "../../stores/editUi";
import SizeFooter from "./SizeFooter";

const opened = (srcFormat: SrcFormat): EditOpened => ({
  session: 1, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat, hasAlpha: false, fileSize: 1000,
});

afterEach(() => act(() => useEditUi.setState({ opened: null, result: null, batch: null })));

describe("SizeFooter", () => {
  it.each([
    ["heif", "HEIC"],
    ["avif", "AVIF"],
    ["gif", "GIF"],
    ["jpeg", "JPG"],
  ] as const)("源格式 %s 的左侧标签是 %s，不出现 undefined", (src, label) => {
    act(() => useEditUi.setState({ opened: opened(src), tab: "convert", result: null, batch: null }));
    const { container } = render(<SizeFooter />);
    const left = container.querySelector(".edit-size-src")!.textContent!;
    expect(left).toContain(label);
    expect(container.textContent).not.toContain("undefined");
  });
});
