// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openRecent } from "../../app/openFolder";
import { formatKey, IS_MAC } from "../../app/keys";
import { t } from "../../i18n";
import { recentsList, recentsPin, recentsRemove } from "../../ipc/api";
import type { RecentEntry } from "../../ipc/types";
import { thumbKeyUrl } from "../../lib/glanceUrl";
import { useRecents } from "../../stores/recents";
import StartView from "./StartView";

vi.mock("../../ipc/api", () => ({
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
    const btn = screen.getByRole("button", { name: new RegExp(t("start.open")) });
    expect(btn.querySelector("kbd")?.textContent).toBe(formatKey("Mod+O", IS_MAC));
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
    const imgs = container.querySelectorAll("img");
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
});
