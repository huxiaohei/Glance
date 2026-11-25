import { beforeEach, describe, expect, it } from "vitest";
import { FIT_VIEWPORT, type CompareViewport } from "../lib/compareViewport";
import { useCompareUi, viewportOf } from "./compareUi";

const ZOOMED: CompareViewport = { scale: { kind: "rel", k: 2 }, u: 0.3, v: 0.7 };

beforeEach(() => {
  useCompareUi.setState({ viewport: FIT_VIEWPORT, perCell: null, focus: null, captions: true });
});

describe("compareUi", () => {
  it("enter：视口回到适应、焦点为第一张；同步开时 perCell 为 null，关时为空 Map", () => {
    useCompareUi.setState({ viewport: ZOOMED, focus: 9 });
    useCompareUi.getState().enter(true, 3);
    let s = useCompareUi.getState();
    expect(s.viewport).toEqual(FIT_VIEWPORT);
    expect(s.perCell).toBeNull();
    expect(s.focus).toBe(3);
    useCompareUi.getState().enter(false, null);
    s = useCompareUi.getState();
    expect(s.perCell).toBeInstanceOf(Map);
    expect(s.perCell!.size).toBe(0);
    expect(s.focus).toBeNull();
  });

  it("enter 不改说明开关（说明只在本次运行内记住）", () => {
    useCompareUi.getState().toggleCaptions();
    useCompareUi.getState().enter(true, 1);
    expect(useCompareUi.getState().captions).toBe(false);
  });

  it("viewportOf：同步开时取共享视口；关时取该格自己的，没有则取共享视口", () => {
    useCompareUi.setState({ viewport: ZOOMED });
    expect(viewportOf(useCompareUi.getState(), 1)).toBe(ZOOMED);
    const own: CompareViewport = { scale: { kind: "px", s: 1 }, u: 0.5, v: 0.5 };
    useCompareUi.setState({ perCell: new Map([[1, own]]) });
    expect(viewportOf(useCompareUi.getState(), 1)).toBe(own);
    expect(viewportOf(useCompareUi.getState(), 2)).toBe(ZOOMED);
  });

  it("toggleSync：开 → 关得到空 Map（各格从共享视口出发）；关 → 开时共享视口取焦点格自己的", () => {
    useCompareUi.setState({ viewport: ZOOMED, focus: 2 });
    useCompareUi.getState().toggleSync();
    expect(useCompareUi.getState().perCell).toEqual(new Map());
    expect(useCompareUi.getState().viewport).toBe(ZOOMED);
    const own: CompareViewport = { scale: { kind: "px", s: 1 }, u: 0.1, v: 0.2 };
    useCompareUi.setState({ perCell: new Map([[2, own]]) });
    useCompareUi.getState().toggleSync();
    expect(useCompareUi.getState().perCell).toBeNull();
    expect(useCompareUi.getState().viewport).toBe(own);
  });
});
