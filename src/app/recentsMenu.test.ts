import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { RecentEntry } from "../ipc/types";
import { openRecent, pickAndOpenFolder } from "./openFolder";
import { recentsMenu } from "./recentsMenu";

vi.mock("./openFolder", () => ({
  openRecent: vi.fn(),
  pickAndOpenFolder: vi.fn(),
}));

function entry(path: string, name: string, exists = true): RecentEntry {
  return { path, name, count: null, thumbs: [], pinned: false, exists, sort: null, includeSubdirs: null };
}

describe("recentsMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("列出存在的其他目录，标签是“名称 — 路径”，顺序与列表一致", () => {
    const menu = recentsMenu([entry("/a", "a"), entry("/b", "b")], null);
    expect(menu.slice(0, 2).map((n) => (n.kind === "item" ? n.label : ""))).toEqual(["a — /a", "b — /b"]);
  });

  it("不列当前目录和已不存在的目录", () => {
    const menu = recentsMenu([entry("/a", "a"), entry("/b", "b", false), entry("/c", "c")], "/a");
    const labels = menu.map((n) => (n.kind === "item" ? n.label : "|"));
    expect(labels).toEqual(["c — /c", "|", t("grid.openOther")]);
  });

  it("有目录项时后面跟分隔线，最后是带 Mod+O 的“打开其他目录”", () => {
    const menu = recentsMenu([entry("/a", "a")], null);
    expect(menu).toHaveLength(3);
    expect(menu[1]).toEqual({ kind: "separator" });
    expect(menu[2]).toMatchObject({ kind: "item", label: t("grid.openOther"), accelerator: "Mod+O", enabled: true });
  });

  it("没有可列的目录时只有“打开其他目录”一项，没有分隔线", () => {
    const menu = recentsMenu([entry("/a", "a")], "/a");
    expect(menu).toHaveLength(1);
    expect(menu[0]).toMatchObject({ kind: "item", label: t("grid.openOther") });
  });

  it("点目录项调用 openRecent；点最后一项调用 pickAndOpenFolder", () => {
    const e = entry("/a", "a");
    const menu = recentsMenu([e], null);
    if (menu[0].kind === "item") menu[0].run();
    expect(openRecent).toHaveBeenCalledWith(e);
    const last = menu[menu.length - 1];
    if (last.kind === "item") last.run();
    expect(pickAndOpenFolder).toHaveBeenCalled();
  });
});
