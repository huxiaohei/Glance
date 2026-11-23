import { beforeEach, describe, expect, it } from "vitest";
import { selectOnly } from "../lib/selection";
import { useCatalog } from "./catalog";
import { useListView } from "./listView";
import { useNav } from "./nav";
import { startRename, stopRename, useRename } from "./rename";
import { useSelection } from "./selection";

const ENTRIES = [
  { id: 1, relPath: "a/one.png" },
  { id: 2, relPath: "a/two.png" },
  { id: 3, relPath: "b/three.png" },
];

function open(path = "/r", generation = 1) {
  const c = useCatalog.getState();
  c.begin({ generation, path, name: "r", recursive: true, focus: null });
  c.apply({ type: "batch", generation, entries: ENTRIES.map((e) => ({ ...e, size: 1, mtimeMs: 1 })) });
}

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  useSelection.getState().clear();
  useListView.getState().resetForNewRoot(true);
  stopRename();
  open();
});

describe("rename store", () => {
  it("startRename：网格里取焦点；焦点为空或在折叠分组里时不做事", () => {
    startRename();
    expect(useRename.getState().id).toBeNull();

    useSelection.getState().set(selectOnly(3));
    useListView.getState().toggleCollapsed("b");
    startRename();
    expect(useRename.getState().id).toBeNull();

    useListView.getState().toggleCollapsed("b");
    startRename();
    expect(useRename.getState().id).toBe(3);
    stopRename();
    expect(useRename.getState().id).toBeNull();
  });

  it("startRename：单张视图里取正在显示的那张", () => {
    useSelection.getState().set(selectOnly(1));
    useNav.getState().openSingle(2);
    startRename();
    expect(useRename.getState().id).toBe(2);
  });

  it("条目被移除或换目录后自动退出", () => {
    startRename(2);
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [1] });
    expect(useRename.getState().id).toBe(2);
    useCatalog.getState().apply({ type: "renamed", generation: 1, items: [{ id: 2, relPath: "a/dos.png" }] });
    expect(useRename.getState().id).toBe(2);
    useCatalog.getState().apply({ type: "removed", generation: 1, ids: [2] });
    expect(useRename.getState().id).toBeNull();

    startRename(3);
    open("/other", 2);
    expect(useRename.getState().id).toBeNull();
  });

  it("进出单张视图或单张视图换图时退出", () => {
    startRename(1);
    useNav.getState().openSingle(1);
    expect(useRename.getState().id).toBeNull();
    startRename();
    expect(useRename.getState().id).toBe(1);
    useNav.getState().setCurrent(2);
    expect(useRename.getState().id).toBeNull();
    startRename();
    useNav.getState().back();
    expect(useRename.getState().id).toBeNull();
  });
});
