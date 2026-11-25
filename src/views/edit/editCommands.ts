import { registerCommands, type Command } from "../../app/commands";
import { saveEdit } from "../../app/editSave";
import { t, type MessageKey } from "../../i18n";
import type { EditError, FileId } from "../../ipc/types";
import { noteAnimated } from "../../stores/animated";
import { useCatalog } from "../../stores/catalog";
import { useEditUi } from "../../stores/editUi";
import { topView, useNav } from "../../stores/nav";
import { showToast } from "../../stores/toast";

const ERROR_TEXT: Partial<Record<EditError, MessageKey>> = {
  animated: "edit.err.animated",
  tooLarge: "edit.err.tooLarge",
  notFound: "edit.err.notFound",
};

/** 打开失败时的提示文字；未单列的错误都按“无法读取”。 */
export function editErrorText(error: string): string {
  return t(ERROR_TEXT[error as EditError] ?? "edit.err.decode");
}

/** 对这张图进入编辑模式；不可编辑（动图、超大、读不了）时不进入，给提示条。 */
export async function enterEdit(id: FileId): Promise<void> {
  await useEditUi.getState().open(id);
  const s = useEditUi.getState();
  // 被更新的打开取代时 error 为空，不提示
  if (s.status === "idle" && s.error) {
    if (s.error === "animated") noteAnimated(id, true);
    showToast({ text: editErrorText(s.error) });
  }
}

/** 退出编辑（不保存）：关掉会话，回到普通单张视图。 */
export function exitEdit(): void {
  if (useEditUi.getState().status !== "idle") useEditUi.getState().close();
}

const editCommands: Command[] = [
  {
    id: "edit.open",
    title: "cmd.edit.open",
    category: "cmd.cat.edit",
    keys: ["E"],
    views: ["single"],
    run: ({ repeat }) => {
      const top = topView();
      if (repeat || top.kind !== "single") return;
      void enterEdit(top.id);
    },
  },
  {
    id: "edit.save",
    title: "cmd.edit.save",
    category: "cmd.cat.edit",
    keys: ["Enter"],
    views: ["edit"],
    run: ({ repeat }) => {
      if (!repeat && useEditUi.getState().status === "ready") void saveEdit();
    },
  },
  {
    id: "edit.cancel",
    title: "cmd.edit.cancel",
    category: "cmd.cat.edit",
    keys: ["Escape"],
    views: ["edit"],
    run: ({ repeat }) => {
      // 保存进行中不取消：结果由保存流程收尾
      if (!repeat && useEditUi.getState().status !== "saving") exitEdit();
    },
  },
];

/**
 * 编辑模式跟着单张视图走：栈顶不再是正在编辑的那张（返回网格、切到别的图、换目录）就关掉会话。
 * 原图在目录事件里被删除或改名时退出编辑并提示；换了一次打开（generation 变了）不算，交给视图栈处理。
 * 保存进行中不管目录事件（覆盖原图本身会引起它们），由保存流程收尾。
 */
function watchEditSource(): () => void {
  const offNav = useNav.subscribe(() => {
    const s = useEditUi.getState();
    if (s.status === "idle") return;
    const top = topView();
    if (top.kind !== "single" || top.id !== s.id) s.close();
  });
  const offCatalog = useCatalog.subscribe((state, prev) => {
    const s = useEditUi.getState();
    if (s.status === "idle" || s.status === "saving" || s.id === null) return;
    if (state.entries === prev.entries || state.root?.generation !== prev.root?.generation) return;
    const before = prev.entries.get(s.id);
    if (!before) return;
    const after = state.entries.get(s.id);
    if (after && after.relPath === before.relPath) return;
    s.close();
    showToast({ text: t("edit.toast.sourceChanged") });
  });
  return () => {
    offCatalog();
    offNav();
  };
}

/** 应用启动时注册一次：编辑命令（按视图生效）与编辑会话的收尾监听；返回注销函数。 */
export function registerEditCommands(): () => void {
  const off = registerCommands(editCommands);
  const unwatch = watchEditSource();
  return () => {
    unwatch();
    off();
  };
}
