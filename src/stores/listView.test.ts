import { beforeEach, expect, it } from "vitest";
import { useListView } from "./listView";

beforeEach(() => useListView.setState(useListView.getInitialState(), true));

it("默认值", () => {
  expect(useListView.getState()).toMatchObject({
    sort: "name", includeSubdirs: true, dirFilter: null, cell: 160, treeVisible: true });
  expect(useListView.getState().collapsed.size).toBe(0);
});

it("格子大小取整并夹到范围内", () => {
  const s = useListView.getState();
  s.setCell(50);  expect(useListView.getState().cell).toBe(96);
  s.setCell(999); expect(useListView.getState().cell).toBe(320);
  s.setCell(200.6); expect(useListView.getState().cell).toBe(201);
});

it("折叠可切换，且每次换新集合", () => {
  const s = useListView.getState();
  const before = useListView.getState().collapsed;
  s.toggleCollapsed("蜀国");
  expect(useListView.getState().collapsed.has("蜀国")).toBe(true);
  expect(useListView.getState().collapsed).not.toBe(before);
  s.toggleCollapsed("蜀国");
  expect(useListView.getState().collapsed.has("蜀国")).toBe(false);
});

it("换根目录时清空筛选和折叠，保留排序和格子大小", () => {
  const s = useListView.getState();
  s.setSort("size"); s.setCell(240); s.setDirFilter("蜀国"); s.toggleCollapsed("魏国");
  s.resetForNewRoot(false);
  expect(useListView.getState()).toMatchObject({
    sort: "size", cell: 240, dirFilter: null, includeSubdirs: false });
  expect(useListView.getState().collapsed.size).toBe(0);
});
