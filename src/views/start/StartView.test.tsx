// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openRecent } from "../../app/openFolder";
import { formatKey, IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import { appVersion, recentsList, recentsPin, recentsRemove } from "../../ipc/api";
import type { RecentEntry } from "../../ipc/types";
import { thumbKeyUrl } from "../../lib/glanceUrl";
import { useRecents } from "../../stores/recents";
import { useTip } from "../../stores/tip";
import StartView from "./StartView";

vi.mock("../../ipc/api", () => ({
  appVersion: vi.fn(() => Promise.resolve("0.1.0")),
  recentsList: vi.fn(),
  recentsPin: vi.fn(),
  recentsRemove: vi.fn(),
}));
vi.mock("../../app/openFolder", () => ({
  openRecent: vi.fn(() => Promise.resolve()),
  pickAndOpenFolder: vi.fn(() => Promise.resolve(false)),
}));

const entry = (over: Partial<RecentEntry> = {}): RecentEntry => ({
  path: "/Users/me/Pictures/trip",
  name: "trip",
  count: 12,
  thumbs: ["aa11", "bb22"],
  pinned: false,
  exists: true,
  sort: null,
  includeSubdirs: null,
  ...over,
});

/** 挂载并等 loadRecents 用 recentsList 的结果填好列表。 */
async function mount(list: RecentEntry[]) {
  vi.mocked(recentsList).mockResolvedValue(list);
  const r = render(<StartView />);
  await waitFor(() => expect(recentsList).toHaveBeenCalled());
  await act(async () => {});
  return r;
}

beforeEach(() => {
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(recentsList).mockReset();
  vi.mocked(recentsPin).mockReset();
  vi.mocked(recentsRemove).mockReset();
  vi.mocked(openRecent).mockClear();
  useRecents.setState({ list: [] });
});

describe("StartView", () => {
  it("挂载时读取最近目录", async () => {
    await mount([entry()]);
    expect(recentsList).toHaveBeenCalledTimes(1);
    expect(useRecents.getState().list).toHaveLength(1);
  });

  it("打开按钮上显示 Mod+O 对应的键名", async () => {
    await mount([]);
    // 键名对读屏隐藏：按钮的可访问名称就是文字本身
    const btn = screen.getByRole("button", { name: t("start.open") });
    expect(btn.querySelector("kbd")?.textContent).toBe(formatKey("Mod+O", IS_MAC));
  });

  it("右下角探头的小老虎没有文字、可访问名称是打赏标题，点它打开打赏面板", async () => {
    const { container } = await mount([]);
    useTip.setState({ open: false });
    const peek = screen.getByRole("button", { name: t("tip.title") });
    // 主图与闭眼贴片两张图都是装饰，可访问名称来自 aria-label
    const imgs = peek.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img.getAttribute("alt")).toBe("");
    expect(peek.querySelector(".start-peek-heart")?.getAttribute("aria-hidden")).toBe("true");
    expect(peek.textContent).toBe("");
    // 原来的文字链接不再出现
    expect(screen.queryByRole("button", { name: t("tip.entry") })).toBeNull();
    expect(container.querySelector(".start-tip")).toBeNull();
    fireEvent.click(peek);
    expect(useTip.getState().open).toBe(true);
    useTip.setState({ open: false });
  });

  it("右下角显示 v<版本号>；取不到版本时不显示", async () => {
    const { unmount } = await mount([]);
    expect(await screen.findByText("v0.1.0")).toBeTruthy();
    unmount();
    vi.mocked(appVersion).mockRejectedValue(new Error("x"));
    const { container } = await mount([]);
    expect(container.querySelector(".start-version")).toBeNull();
  });

  it("没有最近目录时不渲染列表", async () => {
    const { container } = await mount([]);
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector(".recent-list")).toBeNull();
  });

  it("每项显示目录名、完整路径、张数和 4 个缩略图位", async () => {
    const { container } = await mount([entry()]);
    const main = screen.getByRole("button", { name: /trip/ });
    expect(main.textContent).toContain("trip");
    expect(main.textContent).toContain("/Users/me/Pictures/trip");
    expect(main.getAttribute("title")).toBe("/Users/me/Pictures/trip");
    expect(main.textContent).toContain(t("start.count", { n: 12 }));
    const slots = container.querySelectorAll(".recent-thumb");
    expect(slots).toHaveLength(4);
    const imgs = container.querySelectorAll(".recent-thumb img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toBe(thumbKeyUrl("aa11"));
    expect(imgs[1].getAttribute("src")).toBe(thumbKeyUrl("bb22"));
    expect(imgs[0].getAttribute("loading")).toBe("lazy");
    expect(imgs[0].getAttribute("alt")).toBe("");
  });

  it("count 为 null 时不显示张数", async () => {
    const { container } = await mount([entry({ count: null })]);
    expect(container.querySelector(".recent-count")).toBeNull();
  });

  it("点击某项调用 openRecent", async () => {
    const e = entry();
    await mount([e]);
    fireEvent.click(screen.getByRole("button", { name: /trip/ }));
    expect(openRecent).toHaveBeenCalledWith(e);
  });

  it("不存在的目录置灰、不可点开、没有固定按钮，但可以移除", async () => {
    vi.mocked(recentsRemove).mockResolvedValue([]);
    await mount([entry({ exists: false })]);
    const main = screen.getByRole("button", { name: /trip/ }) as HTMLButtonElement;
    expect(main.disabled).toBe(true);
    expect(main.closest("li")?.classList.contains("is-missing")).toBe(true);
    fireEvent.click(main);
    expect(openRecent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: t("start.pin") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("start.unpin") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("start.remove") }));
    expect(recentsRemove).toHaveBeenCalledWith("/Users/me/Pictures/trip");
  });

  it("固定按钮的 aria-pressed 反映状态，点击后调用 pinRecent(path, true)", async () => {
    vi.mocked(recentsPin).mockResolvedValue([entry({ pinned: true })]);
    await mount([entry()]);
    const pin = screen.getByRole("button", { name: t("start.pin") });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    expect(recentsPin).toHaveBeenCalledWith("/Users/me/Pictures/trip", true);
    const unpin = await screen.findByRole("button", { name: t("start.unpin") });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(openRecent).not.toHaveBeenCalled();
  });

  it("点击移除调用 removeRecent(path)，不触发打开", async () => {
    vi.mocked(recentsRemove).mockResolvedValue([]);
    await mount([entry()]);
    fireEvent.click(screen.getByRole("button", { name: t("start.remove") }));
    expect(recentsRemove).toHaveBeenCalledWith("/Users/me/Pictures/trip");
    expect(openRecent).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
  });

  it("缩略图加载失败时隐藏该图", async () => {
    const { container } = await mount([entry()]);
    const img = container.querySelectorAll("img")[0];
    expect(img.hidden).toBe(false);
    fireEvent.error(img);
    expect(img.hidden).toBe(true);
  });

  it("某个位置的缩略图换了缓存键后显示新图，不沿用之前失败时的隐藏", async () => {
    const { container } = await mount([entry()]);
    fireEvent.error(container.querySelectorAll("img")[0]);
    expect(container.querySelectorAll("img")[0].hidden).toBe(true);
    act(() => useRecents.setState({ list: [entry({ thumbs: ["cc33", "bb22"] })] }));
    const img = container.querySelectorAll("img")[0];
    expect(img.getAttribute("src")).toBe(thumbKeyUrl("cc33"));
    expect(img.hidden).toBe(false);
  });
});
