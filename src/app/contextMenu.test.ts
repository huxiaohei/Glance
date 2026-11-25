import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./fileOps", () => ({
  transferTo: vi.fn(),
  pickAndTransfer: vi.fn(),
  transferToNewChild: vi.fn(),
  opTargets: vi.fn(() => [1]),
  trashTargets: vi.fn(),
  copyImage: vi.fn(),
  copyPaths: vi.fn(),
  revealFirst: vi.fn(),
}));
vi.mock("../ipc/api", () => ({ fsRecentTargets: vi.fn(async () => ["/a/pics"]) }));
vi.mock("./nativeMenu", () => ({ popup: vi.fn(async () => {}) }));

import { t } from "../i18n";
import type { MessageKey } from "../i18n";
import { fsRecentTargets } from "../ipc/api";
import { useCatalog } from "../stores/catalog";
import { useNav } from "../stores/nav";
import { registerCompareCommands } from "../views/compare/compareCommands";
import { registerGridCommands } from "../views/grid/gridCommands";
import { buildImageMenu, showImageMenu, type MenuNode } from "./contextMenu";
import { registerFileCommands } from "./fileCommands";
import { opTargets, pickAndTransfer, transferTo, transferToNewChild } from "./fileOps";
import { popup } from "./nativeMenu";

let unregister: Array<() => void> = [];
beforeEach(() => {
  unregister = [registerFileCommands(true), registerGridCommands(), registerCompareCommands()];
});
afterEach(() => {
  unregister.forEach((u) => u());
  vi.clearAllMocks();
});

const T = (k: MessageKey) => t(k);
type Item = Extract<MenuNode, { kind: "item" }>;
type Sub = Extract<MenuNode, { kind: "submenu" }>;
const labels = (nodes: MenuNode[]) => nodes.map((n) => (n.kind === "separator" ? "-" : n.label));
const find = (nodes: MenuNode[], label: string) => nodes.find((n) => n.kind !== "separator" && n.label === label)!;

describe("buildImageMenu", () => {
  it("网格单选：四组齐全，顺序与表一致，快捷键取自命令表", () => {
    const m = buildImageMenu({ view: "grid", count: 1, recent: [] });
    expect(labels(m)).toEqual([
      T("cmd.grid.open"), "-", T("cmd.file.rename"), T("menu.moveTo"), T("menu.copyTo"), T("cmd.file.trash"), "-", T("cmd.file.copyImage"), T("cmd.file.copyPath"), T("cmd.file.revealMac"),
    ]);
    expect((find(m, T("cmd.grid.open")) as Item).accelerator).toBe("Enter");
    expect((find(m, T("cmd.file.rename")) as Item).accelerator).toBe("F2");
    expect((find(m, T("cmd.file.trash")) as Item).accelerator).toBe("Mod+Backspace");
    expect((find(m, T("cmd.file.copyImage")) as Item).accelerator).toBe("Mod+C");
    expect((find(m, T("cmd.file.copyPath")) as Item).accelerator).toBe("Mod+Shift+C");
    expect((find(m, T("cmd.file.revealMac")) as Item).accelerator).toBeUndefined();
    expect(m.every((n) => n.kind === "separator" || n.enabled)).toBe(true);
  });

  it("多选时打开、重命名、复制图片、显示均不可用，其余可用", () => {
    const m = buildImageMenu({ view: "grid", count: 3, recent: [] });
    const enabled = (l: string) => (find(m, l) as Item).enabled;
    for (const l of [T("cmd.grid.open"), T("cmd.file.rename"), T("cmd.file.copyImage"), T("cmd.file.revealMac")]) expect(enabled(l)).toBe(false);
    for (const l of [T("menu.moveTo"), T("menu.copyTo"), T("cmd.file.trash"), T("cmd.file.copyPath")]) expect(enabled(l)).toBe(true);
  });

  it("对比视图：恰为四项——移出对比、复制图片、复制路径、在访达中显示，不含删除", () => {
    const m = buildImageMenu({ view: "compare", count: 1, recent: ["/a/pics"] });
    expect(labels(m)).toEqual([T("cmd.compare.remove"), "-", T("cmd.file.copyImage"), T("cmd.file.copyPath"), T("cmd.file.revealMac")]);
    expect(m.filter((n) => n.kind !== "separator")).toHaveLength(4);
    expect((find(m, T("cmd.compare.remove")) as Item).accelerator).toBe("Delete");
  });

  it("没有操作对象时菜单为空", () => {
    expect(buildImageMenu({ view: "grid", count: 0, recent: [] })).toEqual([]);
  });

  it("单张视图里没有“打开”", () => {
    const m = buildImageMenu({ view: "single", count: 1, recent: [] });
    expect(labels(m)).toEqual([T("cmd.file.rename"), T("menu.moveTo"), T("menu.copyTo"), T("cmd.file.trash"), "-", T("cmd.file.copyImage"), T("cmd.file.copyPath"), T("cmd.file.revealMac")]);
  });

  it("移动到的子菜单：最近目标在前，随后是新建子目录与选择目录；没有最近目标时不出现多余的分隔线", () => {
    const withRecent = find(buildImageMenu({ view: "grid", count: 1, recent: ["/a/pics", "/b/misc"] }), T("menu.moveTo")) as Sub;
    expect(labels(withRecent.children)).toEqual(["pics", "misc", "-", T("menu.newDir"), T("menu.pickDir")]);
    const none = find(buildImageMenu({ view: "grid", count: 1, recent: [] }), T("menu.moveTo")) as Sub;
    expect(labels(none.children)).toEqual([T("menu.newDir"), T("menu.pickDir")]);
    (find(withRecent.children, T("menu.newDir")) as Item).run();
    expect(transferToNewChild).toHaveBeenCalledWith("move");
    (find(withRecent.children, T("menu.pickDir")) as Item).run();
    expect(pickAndTransfer).toHaveBeenCalledWith("move");
  });

  it("两个最近目标的末级目录同名时显示完整路径", () => {
    const sub = find(buildImageMenu({ view: "grid", count: 1, recent: ["/a/pics", "C:\\b\\pics\\", "/c/other"] }), T("menu.moveTo")) as Sub;
    expect(labels(sub.children).slice(0, 3)).toEqual(["/a/pics", "C:\\b\\pics\\", "other"]);
  });

  it("点击最近目标以 { kind: 'path', path } 调用 transferTo", () => {
    const mv = find(buildImageMenu({ view: "grid", count: 1, recent: ["/a/pics"] }), T("menu.moveTo")) as Sub;
    (mv.children[0] as Item).run();
    expect(transferTo).toHaveBeenCalledWith("move", { kind: "path", path: "/a/pics" });
    const cp = find(buildImageMenu({ view: "grid", count: 1, recent: ["/a/pics"] }), T("menu.copyTo")) as Sub;
    (cp.children[0] as Item).run();
    expect(transferTo).toHaveBeenCalledWith("copy", { kind: "path", path: "/a/pics" });
  });

  it("复制到的子菜单没有新建子目录", () => {
    const cp = find(buildImageMenu({ view: "grid", count: 1, recent: ["/a/pics"] }), T("menu.copyTo")) as Sub;
    expect(labels(cp.children)).toEqual(["pics", "-", T("menu.pickDir")]);
  });
});

describe("showImageMenu", () => {
  beforeEach(() => {
    useCatalog.setState({ root: { path: "/r" } as never });
    useNav.getState().reset();
  });

  it("取最近目标后弹出菜单", async () => {
    await showImageMenu();
    expect(popup).toHaveBeenCalledTimes(1);
    const nodes = vi.mocked(popup).mock.calls[0][0];
    expect(labels(nodes)).toContain(T("menu.moveTo"));
    const sub = find(nodes, T("menu.moveTo")) as Sub;
    expect(labels(sub.children)[0]).toBe("pics");
  });

  it("取最近目标失败时当作没有；没有对象时不弹", async () => {
    vi.mocked(fsRecentTargets).mockRejectedValueOnce(new Error("x"));
    await showImageMenu();
    expect(popup).toHaveBeenCalledTimes(1);
    vi.mocked(opTargets).mockReturnValueOnce([]);
    await showImageMenu();
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it("basket 来源的单张视图里不出重命名、移动、复制到与删除", async () => {
    useNav.getState().openCompare();
    useNav.getState().openSingle(1, "basket");
    await showImageMenu();
    const nodes = vi.mocked(popup).mock.calls[0][0];
    expect(labels(nodes)).toEqual([T("cmd.file.copyImage"), T("cmd.file.copyPath"), T("cmd.file.revealMac")]);
  });

  it("对比视图里弹出的菜单恰为四项，不含删除", async () => {
    useNav.getState().openCompare();
    await showImageMenu();
    const nodes = vi.mocked(popup).mock.calls[0][0];
    expect(labels(nodes)).toEqual([T("cmd.compare.remove"), "-", T("cmd.file.copyImage"), T("cmd.file.copyPath"), T("cmd.file.revealMac")]);
  });
});
