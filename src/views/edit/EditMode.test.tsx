// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { activeView, allCommands } from "../../app/commands";
import { buildImageMenu } from "../../app/contextMenu";
import { saveEdit } from "../../app/editSave";
import { t } from "../../i18n";
import {
  appVersion, basketRestore, editClose, editOpen, editParamsGet, editPreview, editResultUrl, fsRename, fsTrash, fsUndo,
  onOpenRequest, takeOpenRequest, thumbsSubscribe, thumbsWant, updateCheck,
} from "../../ipc/api";
import type { EditOpened } from "../../ipc/types";
import { selectOnly } from "../../lib/selection";
import { useAnimated } from "../../stores/animated";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useEditUi } from "../../stores/editUi";
import { useListView } from "../../stores/listView";
import { topView, useNav } from "../../stores/nav";
import { useRename } from "../../stores/rename";
import { useSelection } from "../../stores/selection";
import { useThumbs } from "../../stores/thumbs";
import { useToast } from "../../stores/toast";
import { undoLast } from "../../app/fileOps";
import { useStageApi } from "../single/Stage";
import { useSingleUi } from "../../stores/singleUi";

vi.mock("../../ipc/api");
vi.mock("../../app/editSave", () => ({ saveEdit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../../app/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/keys")>()),
  IS_MAC: true,
}));

let restore: (() => void)[] = [];
const stubSize = (prop: "clientWidth" | "clientHeight", value: number) => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop)!;
  Object.defineProperty(Element.prototype, prop, { configurable: true, get: () => value });
  restore.push(() => Object.defineProperty(Element.prototype, prop, desc));
};

const opened = (session: number): EditOpened => ({
  session, width: 100, height: 50, proxyW: 100, proxyH: 50, srcFormat: "jpeg", hasAlpha: false, fileSize: 1000,
});

beforeEach(() => {
  vi.mocked(thumbsSubscribe).mockResolvedValue();
  vi.mocked(takeOpenRequest).mockResolvedValue(null);
  vi.mocked(basketRestore).mockResolvedValue([]);
  vi.mocked(updateCheck).mockResolvedValue(null);
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(onOpenRequest).mockResolvedValue(() => {});
  vi.mocked(thumbsWant).mockResolvedValue([]);
  vi.mocked(editParamsGet).mockRejectedValue("none");
  vi.mocked(editOpen).mockResolvedValue(opened(1));
  vi.mocked(editClose).mockResolvedValue();
  vi.mocked(editPreview).mockImplementation(async (_s, rev) => ({
    rev, bytes: 10, approx: false, format: "jpeg", width: 100, height: 50,
  }));
  vi.mocked(editResultUrl).mockImplementation((s, r) => `glance://localhost/edit/${s}/${r}`);
  stubSize("clientWidth", 600);
  stubSize("clientHeight", 400);
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  restore.push(() =>
    desc ? Object.defineProperty(HTMLImageElement.prototype, "decode", desc) : delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode,
  );
  useCatalog.getState().reset();
  useNav.getState().reset();
  useThumbs.getState().reset();
  useSelection.getState().clear();
  useListView.setState({ collapsed: new Set(), dirFilter: null, includeSubdirs: true, sort: "name", cell: 160 });
  useToast.setState({ current: null });
  useAnimated.setState({ ids: new Set() });
});
afterEach(() => {
  useEditUi.getState().close();
  vi.mocked(saveEdit).mockClear();
  vi.mocked(editClose).mockClear();
  for (const r of restore) r();
  restore = [];
});

const open = () => {
  act(() => {
    useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
  });
};
const add = (...ids: number[]) => {
  act(() => {
    useCatalog.getState().apply({
      type: "batch",
      generation: 1,
      entries: ids.map((id) => ({ id, size: 1, mtimeMs: 1, relPath: `${id}.jpg` })),
    });
  });
};
const key = (k: string, o: Partial<KeyboardEventInit> = {}) => {
  act(() => {
    fireEvent.keyDown(document.body, { key: k, ...o });
  });
};
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const toastText = () => useToast.getState().current?.text;

/** 打开目录、进入单张视图看 2 号图并按 E 进入编辑。 */
async function enterEditing() {
  open();
  const r = render(<App />);
  add(1, 2, 3);
  act(() => useNav.getState().openSingle(2));
  await settle();
  key("e");
  await settle();
  return r;
}

describe("编辑模式", () => {
  it("e_enters_edit_mode", async () => {
    const { container } = await enterEditing();
    expect(editOpen).toHaveBeenCalledWith(2);
    expect(useEditUi.getState().status).toBe("ready");
    expect(activeView()).toBe("edit");
    // 结果图层出现在画面里
    expect(container.querySelector(".stage .edit-layer")).toBeTruthy();
    // 右侧出现编辑面板
    expect(container.querySelector(".single-middle .edit-panel")).toBeTruthy();
    // 顶栏有“编辑”按钮
    expect(container.querySelector(".topbar-edit")).toBeTruthy();
  });

  it("single_commands_inactive_while_editing", async () => {
    await enterEditing();
    expect(activeView()).toBe("edit");
    key("ArrowRight");
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    key(" ");
    expect(useBasket.getState().order).not.toContain(2);
    key("F2");
    expect(useRename.getState().id).toBeNull();
    key("Delete");
    key("Backspace", { metaKey: true });
    expect(fsTrash).not.toHaveBeenCalled();
    expect(fsRename).not.toHaveBeenCalled();
    // 撤销上一次文件操作也不响应：快捷键与提示条上的“撤销”按钮
    key("z", { metaKey: true });
    await act(() => undoLast());
    expect(fsUndo).not.toHaveBeenCalled();
    // 滚轮切图走的 go() 也不切
    const { go } = await import("../single/go");
    act(() => go("next"));
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    expect(useEditUi.getState().status).toBe("ready");
  });

  it("zoom_keys_work_while_editing", async () => {
    await enterEditing();
    const api = useStageApi.getState().api!;
    const zoomBy = vi.spyOn(api, "zoomBy");
    const fit = vi.spyOn(api, "fit");
    const actual = vi.spyOn(api, "actual");
    key("+");
    key("-");
    key("0");
    key("1");
    expect(zoomBy.mock.calls).toEqual([[1.25], [0.8]]);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(actual).toHaveBeenCalledTimes(1);
    key("i");
    expect(useSingleUi.getState().infoOpen).toBe(true);
    act(() => useSingleUi.setState({ infoOpen: false }));
    expect(useEditUi.getState().status).toBe("ready");
  });

  it("zoom_keys_inactive_on_crop_tab", async () => {
    await enterEditing();
    const api = useStageApi.getState().api!;
    const zoomBy = vi.spyOn(api, "zoomBy");
    const fit = vi.spyOn(api, "fit");
    act(() => useEditUi.getState().setTab("crop"));
    key("+");
    key("-");
    key("0");
    key("1");
    expect(zoomBy).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    act(() => useEditUi.getState().setTab("removeBg"));
    key("+");
    expect(zoomBy).toHaveBeenCalledWith(1.25);
  });

  it("crop_tab_hides_result_layer_and_shows_crop_stage", async () => {
    const { container } = await enterEditing();
    const layer = () => container.querySelector(".edit-layer") as HTMLElement | null;
    act(() => {
      fireEvent.load(layer()!.querySelector("img")!);
    });
    expect(layer()!.classList.contains("shown")).toBe(true);
    act(() => useEditUi.getState().setTab("crop"));
    await settle();
    expect(layer()?.querySelector("img") ?? null).toBeNull();
    expect(layer()?.classList.contains("shown") ?? false).toBe(false);
    expect(container.querySelector(".stage .crop-stage")).toBeTruthy();
    act(() => useEditUi.getState().setTab("compress"));
    expect(container.querySelector(".crop-stage")).toBeNull();
  });

  it("crop_result_does_not_leak_into_other_tabs", async () => {
    const { container } = await enterEditing();
    const layer = () => container.querySelector(".edit-layer") as HTMLElement;
    // 进裁剪前已显示的压缩结果
    act(() => {
      fireEvent.load(layer().querySelector("img")!);
    });
    expect(layer().classList.contains("shown")).toBe(true);
    act(() => useEditUi.getState().setTab("crop"));
    await settle();
    // 裁剪结果到了（EditLayer 在裁剪页不加载它）
    act(() => useEditUi.setState({
      resultUrl: "glance://localhost/edit/1/99",
      result: { rev: 99, bytes: 5, approx: false, format: "jpeg", width: 40, height: 30 },
    }));
    expect(layer().querySelectorAll(".edit-img").length).toBe(0);
    act(() => useEditUi.getState().setTab("compress"));
    // 旧的裁剪结果与进裁剪前的压缩结果都不显示
    expect(layer().classList.contains("shown")).toBe(false);
    expect(layer().querySelectorAll(".edit-img").length).toBe(0);
  });

  it("open_folder_and_refresh_while_editing", async () => {
    await enterEditing();
    const { findCommand } = await import("../../app/commands");
    const ev = (k: string, meta = false) =>
      ({ key: k, metaKey: meta, ctrlKey: false, altKey: false, shiftKey: false }) as KeyboardEvent;
    // Mod+O 不换目录；F5 仍被拦下（不落到 WebView 重新载入页面）
    expect(findCommand(ev("o", true), "edit", false, true)).toBeNull();
    expect(findCommand(ev("F5"), "edit", false, true)?.id).toBe("view.refresh");
  });

  it("enter_saves", async () => {
    await enterEditing();
    key("Enter");
    expect(saveEdit).toHaveBeenCalledTimes(1);
  });

  it("esc_cancels_without_files", async () => {
    await enterEditing();
    key("Escape", { repeat: true });
    expect(useEditUi.getState().status).toBe("ready");
    key("Escape");
    expect(saveEdit).not.toHaveBeenCalled();
    expect(editClose).toHaveBeenCalledWith(1);
    expect(document.querySelector(".edit-panel")).toBeNull();
    expect(useEditUi.getState().status).toBe("idle");
    // 只退出编辑，仍在单张视图
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
    expect(activeView()).toBe("single");
  });

  it("animated_shows_toast_and_stays", async () => {
    vi.mocked(editOpen).mockRejectedValue("animated");
    await enterEditing();
    expect(useEditUi.getState().status).toBe("idle");
    expect(activeView()).toBe("single");
    expect(toastText()).toBe(t("edit.err.animated"));
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 2 });
  });

  it("too_large_and_decode_show_toasts", async () => {
    vi.mocked(editOpen).mockRejectedValue("tooLarge");
    await enterEditing();
    expect(toastText()).toBe(t("edit.err.tooLarge"));
    vi.mocked(editOpen).mockRejectedValue("decode");
    key("e");
    await settle();
    expect(toastText()).toBe(t("edit.err.decode"));
    expect(activeView()).toBe("single");
  });

  it("grid_context_edit_opens_single_then_edit", async () => {
    open();
    render(<App />);
    add(1, 2, 3);
    act(() => useSelection.getState().set(selectOnly(3)));
    const menu = buildImageMenu({ view: "grid", count: 1, recent: [] });
    const item = menu.find((n) => n.kind === "item" && n.label === t("cmd.grid.edit"));
    expect(item).toBeTruthy();
    act(() => {
      if (item?.kind === "item") item.run();
    });
    await settle();
    expect(topView()).toEqual({ kind: "single", source: "folder", id: 3 });
    expect(editOpen).toHaveBeenCalledWith(3);
    expect(useEditUi.getState().status).toBe("ready");
    expect(activeView()).toBe("edit");
  });

  it("single_context_menu_has_edit", () => {
    open();
    render(<App />);
    const menu = buildImageMenu({ view: "single", count: 1, recent: [] });
    expect(menu.some((n) => n.kind === "item" && n.label === t("cmd.edit.open"))).toBe(true);
    const basket = buildImageMenu({ view: "single", count: 1, recent: [], readOnly: true });
    expect(basket.some((n) => n.kind === "item" && n.label === t("cmd.edit.open"))).toBe(true);
    const compare = buildImageMenu({ view: "compare", count: 1, recent: [] });
    expect(compare.some((n) => n.kind === "item" && n.label === t("cmd.edit.open"))).toBe(false);
  });

  it("source_removed_exits_edit", async () => {
    await enterEditing();
    act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: [2] }));
    expect(useEditUi.getState().status).toBe("idle");
    expect(editClose).toHaveBeenCalledWith(1);
    expect(toastText()).toBe(t("edit.toast.sourceChanged"));
  });

  it("source_renamed_exits_edit", async () => {
    await enterEditing();
    act(() => useCatalog.getState().apply({ type: "renamed", generation: 1, items: [{ id: 2, relPath: "x.jpg" }] }));
    expect(useEditUi.getState().status).toBe("idle");
    expect(toastText()).toBe(t("edit.toast.sourceChanged"));
  });

  it("other_removed_keeps_edit", async () => {
    await enterEditing();
    act(() => useCatalog.getState().apply({ type: "removed", generation: 1, ids: [3] }));
    expect(useEditUi.getState().status).toBe("ready");
  });

  it("leaving_single_closes_session", async () => {
    await enterEditing();
    act(() => useNav.getState().back());
    expect(topView().kind).toBe("grid");
    expect(useEditUi.getState().status).toBe("idle");
    expect(editClose).toHaveBeenCalledWith(1);
  });

  it("hold_original_hides_result", async () => {
    const { container } = await enterEditing();
    const layer = () => container.querySelector(".edit-layer") as HTMLElement;
    const imgs = () => [...layer().querySelectorAll("img")];
    // 结果图加载完成前不显示（保留原图）
    expect(layer().classList.contains("shown")).toBe(false);
    const pending = imgs().find((i) => i.getAttribute("src") === "glance://localhost/edit/1/1")!;
    expect(pending).toBeTruthy();
    act(() => {
      fireEvent.load(pending);
    });
    expect(layer().classList.contains("shown")).toBe(true);
    act(() => useEditUi.getState().setShowOriginal(true));
    expect(layer().classList.contains("shown")).toBe(false);
    act(() => useEditUi.getState().setShowOriginal(false));
    expect(layer().classList.contains("shown")).toBe(true);
  });

  it("keeps_previous_result_until_next_loads", async () => {
    const { container } = await enterEditing();
    const layer = () => container.querySelector(".edit-layer") as HTMLElement;
    const byRev = (rev: number) =>
      [...layer().querySelectorAll("img")].find((i) => i.getAttribute("src") === `glance://localhost/edit/1/${rev}`);
    act(() => {
      fireEvent.load(byRev(1)!);
    });
    act(() => useEditUi.getState().patch("compress", { quality: 50 }));
    await settle();
    // 新结果还在加载：上一张仍是显示中的那张
    expect(byRev(1)?.classList.contains("edit-current")).toBe(true);
    expect(byRev(2)).toBeTruthy();
    act(() => {
      fireEvent.load(byRev(2)!);
    });
    expect(byRev(2)?.classList.contains("edit-current")).toBe(true);
    expect(byRev(1)).toBeUndefined();
  });

  it("edit_commands_registered_with_keys", () => {
    open();
    render(<App />);
    const byId = (id: string) => allCommands().find((c) => c.id === id);
    expect(byId("edit.open")?.keys).toEqual(["E"]);
    expect(byId("edit.open")?.views).toEqual(["single"]);
    expect(byId("edit.save")?.keys).toEqual(["Enter"]);
    expect(byId("edit.save")?.views).toEqual(["edit"]);
    expect(byId("edit.cancel")?.keys).toEqual(["Escape"]);
    expect(byId("edit.cancel")?.views).toEqual(["edit"]);
    expect(byId("edit.open")?.category).toBe("cmd.cat.edit");
  });
});

describe("面板控件聚焦时的回车与 Esc", () => {
  /** 在元素上按键（冒泡到 window）；返回是否被拦下默认行为。 */
  const press = (el: Element, k: string) => {
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(el, { key: k });
    });
    return prevented;
  };
  const panel = () => document.querySelector(".edit-panel") as HTMLElement;
  const byLabel = (label: string) => panel().querySelector(`[aria-label="${label}"]`) as HTMLElement;
  const labelled = (text: string) =>
    [...panel().querySelectorAll("label")].find((l) => l.textContent === text)!.querySelector("input") as HTMLInputElement;

  it("enter_saves_and_esc_cancels_from_slider", async () => {
    await enterEditing();
    const slider = panel().querySelector("#edit-quality") as HTMLInputElement;
    slider.focus();
    expect(press(slider, "Enter")).toBe(true);
    expect(saveEdit).toHaveBeenCalledTimes(1);
    press(slider, "Escape");
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("enter_saves_and_esc_cancels_from_checkbox_and_radio", async () => {
    vi.mocked(editOpen).mockResolvedValue({ ...opened(1), srcFormat: "png" });
    await enterEditing();
    const box = labelled(t("edit.maxEdge"));
    box.focus();
    press(box, "Enter");
    expect(saveEdit).toHaveBeenCalledTimes(1);
    const radio = labelled(t("edit.pngMode.lossless"));
    radio.focus();
    press(radio, "Enter");
    expect(saveEdit).toHaveBeenCalledTimes(2);
    press(radio, "Escape");
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("enter_in_max_edge_commits_then_saves", async () => {
    await enterEditing();
    act(() => {
      fireEvent.click(labelled(t("edit.maxEdge")));
    });
    const edge = byLabel(t("edit.maxEdge.value")) as HTMLInputElement;
    edge.focus();
    act(() => {
      fireEvent.change(edge, { target: { value: "1200" } });
    });
    press(edge, "Enter");
    expect(useEditUi.getState().compress.maxEdge).toBe(1200);
    expect(document.activeElement).not.toBe(edge);
    expect(saveEdit).toHaveBeenCalledTimes(1);
  });

  it("enter_on_cancel_button_cancels_without_saving", async () => {
    await enterEditing();
    const cancel = [...panel().querySelectorAll("button")].find((b) => b.textContent === t("edit.cancel"))!;
    cancel.focus();
    expect(press(cancel, "Enter")).toBe(false);
    expect(saveEdit).not.toHaveBeenCalled();
    // 浏览器随后按下该按钮
    act(() => {
      fireEvent.click(cancel);
    });
    expect(useEditUi.getState().status).toBe("idle");
    expect(saveEdit).not.toHaveBeenCalled();
  });

  it("enter_on_more_button_opens_menu_without_saving", async () => {
    await enterEditing();
    const more = byLabel(t("edit.save.more"));
    more.focus();
    expect(press(more, "Enter")).toBe(false);
    act(() => {
      fireEvent.click(more);
    });
    expect(panel().querySelector('[role="menu"]')).toBeTruthy();
    expect(saveEdit).not.toHaveBeenCalled();
  });

  it("enter_on_tab_button_switches_tab_without_saving", async () => {
    await enterEditing();
    const tab = [...panel().querySelectorAll('[role="tab"]')].find((b) => b.textContent === t("edit.tab.convert")) as HTMLElement;
    tab.focus();
    expect(press(tab, "Enter")).toBe(false);
    act(() => {
      fireEvent.click(tab);
    });
    expect(useEditUi.getState().tab).toBe("convert");
    expect(saveEdit).not.toHaveBeenCalled();
  });

  it("esc_with_save_menu_open_closes_menu_first", async () => {
    await enterEditing();
    const more = byLabel(t("edit.save.more"));
    act(() => {
      fireEvent.click(more);
    });
    expect(panel().querySelector('[role="menu"]')).toBeTruthy();
    // 第一次 Esc 只收起下拉，不退出编辑
    act(() => {
      press(more, "Escape");
    });
    expect(panel().querySelector('[role="menu"]')).toBeNull();
    expect(useEditUi.getState().status).toBe("ready");
    // 再按一次才取消编辑
    act(() => {
      press(more, "Escape");
    });
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("esc_on_panel_button_still_cancels", async () => {
    await enterEditing();
    const more = byLabel(t("edit.save.more"));
    more.focus();
    press(more, "Escape");
    expect(useEditUi.getState().status).toBe("idle");
  });
});

describe("顶栏编辑按钮", () => {
  it("button_disabled_after_known_animated", async () => {
    vi.mocked(editOpen).mockRejectedValue("animated");
    const { container } = await enterEditing();
    const btn = container.querySelector(".topbar-edit") as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toBe(t("edit.button.animated"));
    vi.mocked(editOpen).mockClear();
    fireEvent.click(btn);
    await settle();
    expect(editOpen).not.toHaveBeenCalled();
  });

  it("button_enters_edit", async () => {
    open();
    const { container } = render(<App />);
    add(1, 2, 3);
    act(() => useNav.getState().openSingle(3));
    await settle();
    const btn = container.querySelector(".topbar-edit") as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(btn);
    await settle();
    expect(editOpen).toHaveBeenCalledWith(3);
    expect(activeView()).toBe("edit");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });
});
