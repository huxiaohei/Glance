import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMenu { items: unknown; popup: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
const made: FakeMenu[] = [];

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: {
    new: vi.fn(async (opts: { items: unknown }) => {
      const menu: FakeMenu = { items: opts.items, popup: vi.fn(async () => {}), close: vi.fn(async () => {}) };
      made.push(menu);
      return menu;
    }),
  },
}));

import { popup } from "./nativeMenu";

beforeEach(() => {
  made.length = 0;
});

describe("popup", () => {
  it("弹出后不立即关闭菜单；下次弹出前关闭上一个", async () => {
    await popup([{ kind: "item", label: "a", enabled: true, run: () => {} }]);
    expect(made).toHaveLength(1);
    expect(made[0].popup).toHaveBeenCalledOnce();
    expect(made[0].close).not.toHaveBeenCalled();

    await popup([{ kind: "item", label: "b", enabled: true, run: () => {} }]);
    expect(made[0].close).toHaveBeenCalledOnce();
    expect(made[1].close).not.toHaveBeenCalled();
  });

  it("关闭上一个失败时照常弹出", async () => {
    await popup([{ kind: "item", label: "a", enabled: true, run: () => {} }]);
    made[made.length - 1].close.mockRejectedValue(new Error("gone"));
    await popup([{ kind: "item", label: "b", enabled: true, run: () => {} }]);
    expect(made[made.length - 1].popup).toHaveBeenCalledOnce();
  });

  it("标签里的 & 写成 &&，子菜单也是", async () => {
    await popup([
      { kind: "submenu", label: "A&B", enabled: true, children: [{ kind: "item", label: "R&D", enabled: true, run: () => {} }] },
    ]);
    expect(made[made.length - 1].items).toEqual([
      { text: "A&&B", enabled: true, items: [expect.objectContaining({ text: "R&&D" })] },
    ]);
  });
});
