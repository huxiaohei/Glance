// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { imageStatus, openCodecHelp } from "../../ipc/api";
import { useThumbs } from "../../stores/thumbs";
import StageFailure from "./StageFailure";

vi.mock("../../ipc/api");
let mac = false;
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  get IS_MAC() {
    return mac;
  },
}));

beforeEach(() => {
  mac = false;
  useThumbs.getState().reset();
});
afterEach(() => vi.clearAllMocks());

async function show(name: string, retry: () => boolean = () => false) {
  const view = render(<StageFailure id={1} url="u1" name={name} retry={retry} />);
  await act(async () => {});
  return view.container;
}

const text = (c: HTMLElement) => c.querySelector(".stage-codec-text")?.textContent ?? null;
const button = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".stage-codec button");

describe("StageFailure", () => {
  it("noCodec：显示缺哪个组件，Windows 上有“如何安装”按钮，点击打开对应的商店页", async () => {
    vi.mocked(imageStatus).mockResolvedValue("noCodec");
    vi.mocked(openCodecHelp).mockResolvedValue();
    const c = await show("a.heic");
    expect(imageStatus).toHaveBeenCalledWith(1);
    expect(text(c)).toBe(t("codec.missing.heif"));
    expect(c.querySelector(".stage-unreadable")).toBeNull();
    expect(button(c)?.textContent).toBe(t("codec.howTo"));
    await act(async () => {
      fireEvent.click(button(c)!);
    });
    expect(openCodecHelp).toHaveBeenCalledWith("heif");
    expect(text(c)).toBe(t("codec.missing.heif"));
    // 缩略图位置与编辑入口也随之认作缺组件
    expect(useThumbs.getState().noCodec.has(1)).toBe(true);
  });

  it("打开商店失败：说明换成“请在 Microsoft Store 里搜索…”", async () => {
    vi.mocked(imageStatus).mockResolvedValue("noCodec");
    vi.mocked(openCodecHelp).mockRejectedValue("only on Windows");
    const c = await show("a.avif");
    expect(text(c)).toBe(t("codec.missing.avif"));
    await act(async () => {
      fireEvent.click(button(c)!);
    });
    expect(openCodecHelp).toHaveBeenCalledWith("avif");
    expect(text(c)).toBe(t("codec.searchStore.avif"));
  });

  it("macOS：没有按钮，AVIF 说明需要 macOS 13", async () => {
    mac = true;
    vi.mocked(imageStatus).mockResolvedValue("noCodec");
    const c = await show("a.avif");
    expect(text(c)).toBe(t("codec.missing.avifMac"));
    expect(button(c)).toBeNull();
  });

  it("broken 或命令失败：现有的“无法读取”", async () => {
    vi.mocked(imageStatus).mockResolvedValue("broken");
    let c = await show("a.heic");
    expect(c.querySelector(".stage-unreadable")?.textContent).toBe(t("grid.unreadable"));
    expect(c.querySelector(".stage-codec")).toBeNull();
    vi.mocked(imageStatus).mockRejectedValue("unknown file id");
    c = await show("b.heic");
    expect(c.querySelector(".stage-unreadable")?.textContent).toBe(t("grid.unreadable"));
  });

  it("ok：之前的失败是一时的，重试一次；不能再重试时显示“无法读取”", async () => {
    vi.mocked(imageStatus).mockResolvedValue("ok");
    const retry = vi.fn(() => true);
    await show("a.heic", retry);
    expect(retry).toHaveBeenCalledTimes(1);
    const c = await show("b.heic", () => false);
    expect(c.querySelector(".stage-unreadable")).not.toBeNull();
  });

  it("等结果时：HEIC / AVIF 先不显示“无法读取”，其他格式照常显示", async () => {
    vi.mocked(imageStatus).mockReturnValue(new Promise(() => {}));
    let { container } = render(<StageFailure id={1} url="u1" name="a.heic" retry={() => false} />);
    expect(container.querySelector(".stage-unreadable")).toBeNull();
    ({ container } = render(<StageFailure id={2} url="u2" name="a.jpg" retry={() => false} />));
    expect(container.querySelector(".stage-unreadable")).not.toBeNull();
  });
});
