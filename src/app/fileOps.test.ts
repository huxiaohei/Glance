import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { fsRename, fsTrash, fsUndo } from "../ipc/api";
import type { OpReport } from "../ipc/types";
import { selectOnly, toggle } from "../lib/selection";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";
import { useNav } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { useToast } from "../stores/toast";
import { errorText, isBusy, opTargets, renameTo, reportOp, trashTargets, undoLast } from "./fileOps";

vi.mock("../ipc/api", () => ({ fsRename: vi.fn(), fsTrash: vi.fn(), fsUndo: vi.fn() }));

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

  it("undoLast：没有可撤销的操作时给出提示", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: null, done: 0, failed: [] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.nothing"));
  });

  it("undoLast：restoreDenied 的说明里提到从废纸篓手动恢复", async () => {
    vi.mocked(fsUndo).mockResolvedValue({ kind: "trash", done: 1, failed: ["restoreDenied"] });
    await undoLast();
    expect(toast()?.text).toBe(t("fs.undo.partial", { m: 1 }));
    expect(toast()?.details).toEqual([errorText("restoreDenied")]);
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

  it("reportOp：尚未单独写文字的操作用通用文字", () => {
    reportOp(report({ kind: "move", done: [1], token: 2 }));
    expect(toast()?.text).toBe(t("fs.done", { n: 1 }));
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
