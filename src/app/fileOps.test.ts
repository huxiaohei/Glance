import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clipboardCopyImage, clipboardCopyPaths, fsCopy, fsMove, fsRename, fsTrash, fsUndo, reveal } from "../ipc/api";
import { askName } from "../views/common/NamePrompt";
import type { OpReport } from "../ipc/types";
import { selectOnly, toggle } from "../lib/selection";
import { useBasket } from "../stores/basket";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";
import { useNav } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { useToast } from "../stores/toast";
import { useEditUi } from "../stores/editUi";
import { copyImage, copyPaths, errorText, isBusy, opTargets, readTargets, revealFirst, pickAndTransfer, renameTo, reportOp, transferTo, transferToNewChild, trashTargets, undoLast } from "./fileOps";

vi.mock("../ipc/api", () => ({
  fsRename: vi.fn(),
  fsTrash: vi.fn(),
  fsUndo: vi.fn(),
  fsMove: vi.fn(),
  fsCopy: vi.fn(),
  clipboardCopyImage: vi.fn(),
  clipboardCopyPaths: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../views/common/NamePrompt", () => ({ askName: vi.fn() }));

// 两个分组：a/1、a/2，b/3、b/4
const ENTRIES = [
  { id: 1, relPath: "a/one.png" },
  { id: 2, relPath: "a/two.png" },
  { id: 3, relPath: "b/three.png" },
  { id: 4, relPath: "b/four.png" },
];

const report = (r: Partial<OpReport>): OpReport => ({ kind: "trash", done: [], failed: [], token: null, dest: null, ...r });
const toast = () => useToast.getState().current;
const action = (label: string) => toast()?.actions?.find((a) => a.label === label);

beforeEach(() => {
  useCatalog.getState().reset();
  useNav.getState().reset();
  useSelection.getState().clear();
  useListView.getState().resetForNewRoot(true);
  useToast.setState({ current: null });
  const c = useCatalog.getState();
  c.begin({ generation: 1, path: "/r", name: "r", recursive: true, focus: null });
  c.apply({ type: "batch", generation: 1, entries: ENTRIES.map((e) => ({ ...e, size: 1, mtimeMs: 1 })) });
});
afterEach(() => vi.clearAllMocks());

describe("opTargets", () => {
  it("opTargets：网格里只取选中且可见的，按列表顺序", () => {
    useSelection.getState().set(toggle(toggle(toggle(selectOnly(3), 1), 4), 2));
    useListView.getState().toggleCollapsed("b");
    expect(opTargets()).toEqual([1, 2]);
  });

  it("opTargets：单张视图里只取正在显示的那张，不管网格选中了什么", () => {
    useSelection.getState().set(toggle(selectOnly(1), 2));
    useNav.getState().openSingle(3);
    expect(opTargets()).toEqual([3]);
  });

  it("opTargets：单张视图里那张已不在列表里时为空", () => {
    useNav.getState().openSingle(3);
    useListView.getState().toggleCollapsed("b");
    expect(opTargets()).toEqual([]);
  });

  it("opTargets：basket 来源时取正在显示的那张，已移出或缺失时为空", () => {
    useBasket.getState().clear();
    useBasket.getState().toggle([2, 3]);
    useNav.getState().openCompare();
    // 不在当前列表里（被筛掉）也不影响 basket 来源
    useListView.getState().toggleCollapsed("b");
    useNav.getState().openSingle(3, "basket");
    expect(opTargets()).toEqual([3]);
    useBasket.setState({ missing: new Set([3]) });
    expect(opTargets()).toEqual([]);
    useBasket.setState({ missing: new Set() });
    useBasket.getState().remove([3]);
    expect(opTargets()).toEqual([]);
  });
});

describe("opTargets（对比视图）", () => {
  it("对比视图里取焦点格；焦点不在篮内或缺失时为空", async () => {
    const { useCompareUi } = await import("../stores/compareUi");
    useBasket.getState().clear();
    useBasket.getState().toggle([2, 3]);
    useNav.getState().openCompare();
    useSelection.getState().set(selectOnly(1));
    useCompareUi.setState({ focus: 3 });
    expect(opTargets()).toEqual([3]);
    useCompareUi.setState({ focus: 1 });
    expect(opTargets()).toEqual([]);
    useCompareUi.setState({ focus: 2 });
    useBasket.setState({ missing: new Set([2]) });
    expect(opTargets()).toEqual([]);
    useCompareUi.setState({ focus: null });
    expect(opTargets()).toEqual([]);
  });
});

describe("trashTargets", () => {
  it("trashTargets：没有对象时不调用后端", async () => {
    await trashTargets();
    expect(fsTrash).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
  });

  it("trashTargets：成功后提示条带撤销；点撤销调用 fsUndo", async () => {
    vi.mocked(fsTrash).mockImplementation(async (ids) => {
      // 条目可能在应答之前就被移除：文件名要在调用之前取好
      useCatalog.getState().apply({ type: "removed", generation: 1, ids });
      return report({ done: ids, token: 7 });
    });
    vi.mocked(fsUndo).mockResolvedValue({ kind: "trash", done: 1, failed: [] });
    useSelection.getState().set(selectOnly(2));
    await trashTargets();
    expect(fsTrash).toHaveBeenCalledWith([2]);
    expect(toast()?.text).toBe(t("fs.trash.one", { name: "two.png" }));
    action(t("fs.undo"))!.run();
    expect(fsUndo).toHaveBeenCalledTimes(1);
  });

  it("trashTargets：多张成功时文字含张数", async () => {
    vi.mocked(fsTrash).mockResolvedValue(report({ done: [1, 2], token: 1 }));
    useSelection.getState().set(toggle(selectOnly(1), 2));
    await trashTargets();
    expect(toast()?.text).toBe(t("fs.trash.many", { n: 2 }));
  });

  it("trashTargets：部分失败时文字含失败数，详情逐行列出文件名与原因", async () => {
    vi.mocked(fsTrash).mockResolvedValue(
      report({ done: [1, 2], failed: [{ id: 3, code: "denied" }, { id: 4, code: "notFound" }], token: 3 }),
    );
    useSelection.getState().set(toggle(toggle(toggle(selectOnly(1), 2), 3), 4));
    await trashTargets();
    expect(toast()?.text).toBe(t("fs.trash.many", { n: 2 }) + t("fs.failedSuffix", { m: 2 }));
    expect(toast()?.details).toEqual([
      t("fs.detailLine", { name: "three.png", reason: errorText("denied") }),
      t("fs.detailLine", { name: "four.png", reason: errorText("notFound") }),
    ]);
    expect(action(t("fs.undo"))).toBeDefined();
  });

  it("trashTargets：全部失败时没有撤销按钮", async () => {
    vi.mocked(fsTrash).mockResolvedValue(report({ failed: [{ id: 1, code: "denied" }, { id: 2, code: "denied" }], token: null }));
    useSelection.getState().set(toggle(selectOnly(1), 2));
    await trashTargets();
    expect(toast()?.text).toBe(t("fs.trash.failMany", { m: 2 }));
    expect(toast()?.details).toHaveLength(2);
    expect(action(t("fs.undo"))).toBeUndefined();
  });

  it("trashTargets：调用本身抛错时给出“操作失败”，不留下未处理的拒绝", async () => {
    vi.mocked(fsTrash).mockRejectedValue(new Error("ipc"));
    useSelection.getState().set(selectOnly(1));
    await expect(trashTargets()).resolves.toBeUndefined();
    expect(toast()?.text).toBe(errorText("other"));
  });
});

describe("undoLast", () => {
  it("undoLast：成功时提示已撤销", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: "trash", done: 2, failed: [] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.done"));
  });

  it("undoLast：撤销批量处理时提示“已撤销批量处理”", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: "batch", done: 3, failed: [] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.batch"));
  });

  it("undoLast：没有可撤销的操作时给出提示", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: null, done: 0, failed: [] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.nothing"));
  });

  it("undoLast：restoreDenied 的说明里提到从废纸篓手动恢复", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: "trash", done: 1, failed: [{ name: "a.png", code: "restoreDenied" }] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.partial", { m: 1 }));
    expect(toast()?.details).toEqual([t("fs.detailLine", { name: "a.png", reason: errorText("restoreDenied") })]);
    expect(errorText("restoreDenied")).toMatch(/废纸篓手动恢复|from the Trash manually/);
  });

  it("undoLast：调用本身抛错时给出“操作失败”", async () => {
    vi.mocked(fsUndo).mockRejectedValue(new Error("ipc"));
    await expect(undoLast()).resolves.toBeUndefined();
    expect(toast()?.text).toBe(errorText("other"));
  });
});

describe("reportOp", () => {
  it("reportOp：有 exists 失败且给了 retry 时出现“保留两者”，点击后以冲突项的 id 和原 token 调用 retry", () => {
    const retry = vi.fn();
    const r = report({ kind: "copy", done: [1], failed: [{ id: 2, code: "exists" }, { id: 3, code: "denied" }, { id: 4, code: "exists" }], token: 9 });
    reportOp(r, { retry });
    action(t("fs.keepBoth"))!.run();
    expect(retry).toHaveBeenCalledWith([2, 4], 9);
  });

  it("reportOp：没有 retry 或没有 exists 失败时不出现“保留两者”", () => {
    reportOp(report({ kind: "copy", failed: [{ id: 2, code: "exists" }] }));
    expect(action(t("fs.keepBoth"))).toBeUndefined();
    reportOp(report({ kind: "copy", failed: [{ id: 2, code: "denied" }] }), { retry: vi.fn() });
    expect(action(t("fs.keepBoth"))).toBeUndefined();
  });
});

describe("renameTo", () => {
  it("renameTo：exists 时返回错误码且不弹提示条；成功时提示条带撤销", async () => {
    vi.mocked(fsRename).mockResolvedValueOnce(report({ kind: "rename", failed: [{ id: 1, code: "exists" }] }));
    expect(await renameTo(1, "two.png")).toBe("exists");
    expect(toast()).toBeNull();

    vi.mocked(fsRename).mockResolvedValueOnce(report({ kind: "rename", done: [1], token: 5 }));
    expect(await renameTo(1, "uno.png")).toBeNull();
    expect(fsRename).toHaveBeenLastCalledWith(1, "uno.png");
    // 条目可能还没更新：文字里是新名字
    expect(toast()?.text).toBe(t("fs.rename.done", { name: "uno.png" }));
    expect(action(t("fs.undo"))).toBeDefined();
  });

  it("renameTo：名字没变或为空时不调用后端；调用抛错时返回 other", async () => {
    expect(await renameTo(1, "one.png")).toBeNull();
    expect(await renameTo(1, "")).toBeNull();
    expect(fsRename).not.toHaveBeenCalled();
    vi.mocked(fsRename).mockRejectedValueOnce(new Error("ipc"));
    expect(await renameTo(1, "x.png")).toBe("other");
    expect(toast()).toBeNull();
  });
});

describe("进行中的操作", () => {
  /** 可手动完成的 Promise。 */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("连续两次 trashTargets（不等第一次）只调用一次后端，只出一条提示", async () => {
    const d = deferred<OpReport>();
    vi.mocked(fsTrash).mockReturnValue(d.promise);
    useSelection.getState().set(selectOnly(1));
    const a = trashTargets();
    const b = trashTargets();
    await b;
    expect(fsTrash).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
    d.resolve(report({ done: [1], token: 1 }));
    await a;
    expect(toast()?.text).toBe(t("fs.trash.one", { name: "one.png" }));
    expect(action(t("fs.undo"))).toBeDefined();
  });

  it("连续两次 undoLast 只调用一次 fsUndo", async () => {
    const d = deferred<{ kind: "trash"; done: number; failed: [] }>();
    vi.mocked(fsUndo).mockReturnValue(d.promise);
    const a = undoLast();
    await undoLast();
    d.resolve({ kind: "trash", done: 1, failed: [] });
    await a;
    expect(fsUndo).toHaveBeenCalledTimes(1);
    expect(toast()?.text).toBe(t("fs.undo.done"));
  });

  it("第一次结束后（成功或抛错）新的调用照常进行", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(fsTrash).mockResolvedValueOnce(report({ done: [1], token: 1 }));
    await trashTargets();
    vi.mocked(fsTrash).mockRejectedValueOnce(new Error("ipc"));
    await trashTargets();
    vi.mocked(fsTrash).mockResolvedValueOnce(report({ done: [1], token: 2 }));
    await trashTargets();
    expect(fsTrash).toHaveBeenCalledTimes(3);
    vi.mocked(fsUndo).mockRejectedValueOnce(new Error("ipc"));
    await undoLast();
    vi.mocked(fsUndo).mockResolvedValueOnce({ kind: null, done: 0, failed: [] });
    await undoLast();
    expect(fsUndo).toHaveBeenCalledTimes(2);
    expect(isBusy()).toBe(false);
  });

  it("重命名进行中时 trashTargets 不做事", async () => {
    const d = deferred<OpReport>();
    vi.mocked(fsRename).mockReturnValue(d.promise);
    useSelection.getState().set(selectOnly(2));
    const r = renameTo(1, "uno.png");
    expect(isBusy()).toBe(true);
    await trashTargets();
    expect(fsTrash).not.toHaveBeenCalled();
    d.resolve(report({ kind: "rename", done: [1], token: 5 }));
    await expect(r).resolves.toBeNull();
    expect(isBusy()).toBe(false);
  });
});

describe("移动与复制", () => {
  const dest = { kind: "path", path: "/x/Out" } as const;

  it("pickAndTransfer：对话框取消时不调用后端", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(openDialog).mockResolvedValue(null);
    await pickAndTransfer("move");
    expect(fsMove).not.toHaveBeenCalled();
  });

  it("pickAndTransfer：默认位置是当前根目录；选定后以 { kind: 'path' } 和 skip 调用 fsMove", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(openDialog).mockResolvedValue("/x/Out");
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1], token: 1, dest: "/x/Out" }));
    await pickAndTransfer("move");
    expect(vi.mocked(openDialog).mock.calls[0][0]).toMatchObject({ directory: true, multiple: false, defaultPath: "/r", title: t("fs.pick.move") });
    expect(fsMove).toHaveBeenCalledWith([1], dest, "skip");
  });

  it("pickAndTransfer：没有对象时不弹对话框", async () => {
    await pickAndTransfer("copy");
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("transferTo：没有对象时不调用后端", async () => {
    await transferTo("move", dest);
    expect(fsMove).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
  });

  it("transferTo：提示条里的目录名取 dest 的最后一级，Windows 路径（反斜杠）同样处理", async () => {
    useSelection.getState().set(toggle(selectOnly(1), 2));
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1, 2], token: 1, dest: "C:\\pics\\Out\\" }));
    await transferTo("move", dest);
    expect(toast()?.text).toBe(t("fs.moved", { n: 2, dir: "Out" }));
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1], token: 2, dest: "/x/Out/" }));
    await transferTo("move", dest);
    expect(toast()?.text).toBe(t("fs.movedOne", { name: "one.png", dir: "Out" }));
  });

  it("transferTo：重名跳过时出现“保留两者”，点击后只带冲突项的 id、keepBoth 和原 token 再调一次", async () => {
    useSelection.getState().set(toggle(toggle(selectOnly(1), 2), 3));
    vi.mocked(fsMove).mockResolvedValueOnce(
      report({ kind: "move", done: [1], failed: [{ id: 2, code: "exists" }, { id: 3, code: "denied" }], token: 9, dest: "/x/Out" }),
    );
    await transferTo("move", dest);
    expect(toast()?.text).toBe(t("fs.movedOne", { name: "one.png", dir: "Out" }) + t("fs.skippedExists", { m: 1 }) + t("fs.failedSuffix", { m: 1 }));
    vi.mocked(fsMove).mockResolvedValueOnce(report({ kind: "move", done: [2], token: 9, dest: "/x/Out" }));
    action(t("fs.keepBoth"))!.run();
    await vi.waitFor(() => expect(fsMove).toHaveBeenCalledTimes(2));
    expect(fsMove).toHaveBeenLastCalledWith([2], { kind: "path", path: "/x/Out" }, "keepBoth", 9);
    await vi.waitFor(() => expect(toast()?.text).toBe(t("fs.movedOne", { name: "two.png", dir: "Out" })));
    expect(action(t("fs.keepBoth"))).toBeUndefined();
  });

  it("transferTo：全部因重名跳过时用专门文字，仍可保留两者", async () => {
    useSelection.getState().set(toggle(selectOnly(1), 2));
    vi.mocked(fsCopy).mockResolvedValue(
      report({ kind: "copy", failed: [{ id: 1, code: "exists" }, { id: 2, code: "exists" }], token: null, dest: "/x/Out" }),
    );
    await transferTo("copy", dest);
    expect(toast()?.text).toBe(t("fs.allExistsCopy"));
    expect(action(t("fs.keepBoth"))).toBeDefined();
  });

  it("transferTo：copy 走 fsCopy", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(fsCopy).mockResolvedValue(report({ kind: "copy", done: [1], token: 1, dest: "/x/Out" }));
    await transferTo("copy", dest);
    expect(fsCopy).toHaveBeenCalledWith([1], dest, "skip");
    expect(fsMove).not.toHaveBeenCalled();
    expect(toast()?.text).toBe(t("fs.copiedOne", { name: "one.png", dir: "Out" }));
  });

  it("transferTo：进行中再次触发被忽略", async () => {
    useSelection.getState().set(selectOnly(1));
    let resolve!: (r: OpReport) => void;
    vi.mocked(fsMove).mockReturnValue(new Promise((res) => (resolve = res)));
    const first = transferTo("move", dest);
    await transferTo("move", dest);
    expect(fsMove).toHaveBeenCalledTimes(1);
    resolve(report({ kind: "move", done: [1], token: 1, dest: "/x/Out" }));
    await first;
  });

  it("transferToNewChild：askName 返回 null 时不调用后端；返回名字时以 newChild 调用", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(askName).mockResolvedValueOnce(null);
    await transferToNewChild("move");
    expect(fsMove).not.toHaveBeenCalled();
    expect(askName).toHaveBeenCalledWith({ title: t("fs.newDir.title"), confirm: t("fs.newDir.confirm") });
    vi.mocked(askName).mockResolvedValueOnce("新目录");
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1], token: 1, dest: "/r/新目录" }));
    await transferToNewChild("move");
    expect(fsMove).toHaveBeenCalledWith([1], { kind: "newChild", name: "新目录" }, "skip");
  });
});

describe("编辑中的操作对象", () => {
  afterEach(() => useEditUi.setState({ status: "idle", id: null }));

  it("编辑中改文件的操作没有对象，复制图片 / 路径与显示取正在编辑的那张", async () => {
    useNav.getState().openSingle(2);
    useEditUi.setState({ status: "ready", id: 2 });
    expect(opTargets()).toEqual([]);
    expect(readTargets()).toEqual([2]);
    vi.mocked(clipboardCopyImage).mockResolvedValue();
    vi.mocked(clipboardCopyPaths).mockResolvedValue();
    vi.mocked(reveal).mockResolvedValue();
    await copyImage();
    expect(clipboardCopyImage).toHaveBeenCalledWith(2);
    await copyPaths();
    expect(clipboardCopyPaths).toHaveBeenCalledWith([2]);
    await revealFirst();
    expect(reveal).toHaveBeenCalledWith(2);
    await trashTargets();
    expect(fsTrash).not.toHaveBeenCalled();
  });

  it("不在编辑时 readTargets 与 opTargets 相同", () => {
    useSelection.getState().set(toggle(selectOnly(3), 1));
    expect(readTargets()).toEqual(opTargets());
  });
});

describe("剪贴板与在文件管理器中显示", () => {
  it("copyImage：复制第一个对象，成功后提示已复制图片", async () => {
    useSelection.getState().set(toggle(selectOnly(2), 1));
    vi.mocked(clipboardCopyImage).mockResolvedValue();
    await copyImage();
    expect(clipboardCopyImage).toHaveBeenCalledWith(1);
    expect(toast()?.text).toBe(t("fs.copiedImage"));
  });

  it("copyImage：tooLarge 时提示图片过大", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(clipboardCopyImage).mockRejectedValue("tooLarge");
    await copyImage();
    expect(toast()?.text).toBe(t("fs.err.tooLarge"));
  });

  it("copyImage：认不出的错误提示操作失败；没有对象时什么都不做", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(clipboardCopyImage).mockRejectedValue(new Error("boom"));
    await copyImage();
    expect(toast()?.text).toBe(errorText("other"));
    useSelection.getState().clear();
    useToast.setState({ current: null });
    await copyImage();
    expect(clipboardCopyImage).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
  });

  it("copyPaths：提示里是对象的数量", async () => {
    useSelection.getState().set(toggle(toggle(selectOnly(3), 1), 2));
    vi.mocked(clipboardCopyPaths).mockResolvedValue();
    await copyPaths();
    expect(clipboardCopyPaths).toHaveBeenCalledWith([1, 2, 3]);
    expect(toast()?.text).toBe(t("fs.copiedPaths", { n: 3 }));
    useSelection.getState().set(selectOnly(4));
    await copyPaths();
    expect(toast()?.text).toBe(t("fs.copiedPath"));
  });

  it("copyPaths：失败时提示原因", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(clipboardCopyPaths).mockRejectedValue("notFound");
    await copyPaths();
    expect(toast()?.text).toBe(t("fs.err.notFound"));
  });

  it("revealFirst：显示第一个对象，成功时不提示，失败时提示原因", async () => {
    useSelection.getState().set(toggle(selectOnly(4), 2));
    vi.mocked(reveal).mockResolvedValue();
    await revealFirst();
    expect(reveal).toHaveBeenCalledWith(2);
    expect(toast()).toBeNull();
    vi.mocked(reveal).mockRejectedValue("notFound");
    await revealFirst();
    expect(toast()?.text).toBe(t("fs.err.notFound"));
  });

  it("pickAndTransfer：对话框打开期间选中变了，移动的仍是发起时的那批", async () => {
    useSelection.getState().set(selectOnly(1));
    let pick!: (v: string) => void;
    vi.mocked(openDialog).mockReturnValue(new Promise((res) => (pick = res)));
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1], token: 1, dest: "/x/Out" }));
    const p = pickAndTransfer("move");
    useSelection.getState().set(selectOnly(3));
    pick("/x/Out");
    await p;
    expect(fsMove).toHaveBeenCalledWith([1], { kind: "path", path: "/x/Out" }, "skip");
    expect(toast()?.text).toBe(t("fs.movedOne", { name: "one.png", dir: "Out" }));
  });

  it("transferToNewChild：名称输入框打开期间选中变了，移动的仍是发起时的那批", async () => {
    useSelection.getState().set(selectOnly(1));
    let answer!: (v: string) => void;
    vi.mocked(askName).mockReturnValue(new Promise((res) => (answer = res)));
    vi.mocked(fsMove).mockResolvedValue(report({ kind: "move", done: [1], token: 1, dest: "/r/n" }));
    const p = transferToNewChild("move");
    useSelection.getState().set(selectOnly(3));
    answer("n");
    await p;
    expect(fsMove).toHaveBeenCalledWith([1], { kind: "newChild", name: "n" }, "skip");
  });

  it("对话框或输入框等待期间，再次 pickAndTransfer / transferToNewChild 被忽略；结束后可再用", async () => {
    useSelection.getState().set(selectOnly(1));
    let pick!: (v: null) => void;
    vi.mocked(openDialog).mockReturnValue(new Promise((res) => (pick = res)));
    const p = pickAndTransfer("move");
    await pickAndTransfer("copy");
    await transferToNewChild("move");
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(askName).not.toHaveBeenCalled();
    pick(null);
    await p;
    vi.mocked(askName).mockResolvedValue(null);
    await transferToNewChild("move");
    expect(askName).toHaveBeenCalledTimes(1);
  });

  it("openDialog 出错时提示操作失败，不产生未处理的拒绝，之后仍可再用", async () => {
    useSelection.getState().set(selectOnly(1));
    vi.mocked(openDialog).mockRejectedValueOnce(new Error("boom"));
    await pickAndTransfer("move");
    expect(toast()?.text).toBe(errorText("other"));
    expect(fsMove).not.toHaveBeenCalled();
    vi.mocked(openDialog).mockResolvedValueOnce(null);
    await pickAndTransfer("move");
    expect(openDialog).toHaveBeenCalledTimes(2);
  });
});
