import { exitBatch, runBatch } from "../../app/batchMode";
import { registerCommands, type Command } from "../../app/commands";
import { saveEdit } from "../../app/editSave";
import { t, type MessageKey } from "../../i18n";
import type { EditError, FileId } from "../../ipc/types";
import { noteAnimated } from "../../stores/animated";
import { useCatalog } from "../../stores/catalog";
import { inBatch, useEditUi } from "../../stores/editUi";
import { isSaveMenuOpen, setSaveMenuOpen } from "../../stores/saveMenu";
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
  const outcome = await useEditUi.getState().open(id);
  // 只看这一次打开自己的结果：被更新的打开取代时不提示
  if (outcome.kind === "failed") {
    if (outcome.error === "animated") noteAnimated(id, true);
    showToast({ text: editErrorText(outcome.error) });
  }
}

/** 退出编辑（不保存）：关掉会话，回到普通单张视图。 */
export function exitEdit(): void {
  if (useEditUi.getState().status !== "idle") useEditUi.getState().close();
}

/** 面板与覆盖确认之内的元素：只有这些输入控件里回车 / Esc 仍算编辑命令。 */
const PANEL = ".edit-panel, .edit-confirm";

function focusedInPanel(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.closest(PANEL) !== null ? el : null;
}

/** 焦点是否在面板外的输入控件上（编辑中不应有，保险起见不抢它的按键）。 */
function inForeignInput(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest(PANEL) !== null) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

/** 回车是否当作“保存”：焦点在面板里的按钮上（页签、取消、下拉、菜单项）时交给按钮自己。 */
function enterSaves(): boolean {
  if (inForeignInput()) return false;
  const el = focusedInPanel();
  return !(el && (el.tagName === "BUTTON" || el.getAttribute("role") === "menuitem"));
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
    // 滑块、单选、勾选等面板控件聚焦时也保存（点过控件后焦点常停在上面）
    allowInInput: true,
    when: enterSaves,
    run: ({ repeat }) => {
      if (repeat) return;
      const batch = inBatch();
      // 批量模式不要求这张图打开成功（打不开的图也能从这里开始批量）
      if (!batch && useEditUi.getState().status !== "ready") return;
      // 最长边输入框：先失焦，把输入定下来（只有有效值会写进参数，失焦后显示回有效值）再保存
      const el = focusedInPanel();
      if (el instanceof HTMLInputElement && el.type === "number") el.blur();
      if (batch) void runBatch();
      else void saveEdit();
    },
  },
  {
    id: "edit.cancel",
    title: "cmd.edit.cancel",
    category: "cmd.cat.edit",
    keys: ["Escape"],
    views: ["edit"],
    allowInInput: true,
    when: () => !inForeignInput(),
    run: ({ repeat }) => {
      if (repeat) return;
      // 保存旁的下拉开着：先收起它
      if (isSaveMenuOpen()) {
        setSaveMenuOpen(false);
        return;
      }
      if (inBatch()) {
        exitBatch();
        return;
      }
      // 保存进行中不取消：结果由保存流程收尾
      if (useEditUi.getState().status !== "saving") exitEdit();
    },
  },
];

/**
 * 编辑模式跟着单张视图走：栈顶不再是正在编辑的那张（返回网格、切到别的图、换目录）就关掉会话。
 * 原图在目录事件里被删除或改名时退出编辑并提示；换了一次打开（generation 变了）不算，交给视图栈处理。
 * 保存进行中不管目录事件（覆盖原图本身会引起它们），由保存流程收尾。
 * 批量模式跟着 selection 来源的单张视图走：栈顶不再是它（换目录回网格等）就退出批量模式；
 * 批量模式里原图被删或改名同样退出（回网格）并提示。
 */
function watchEditSource(): () => void {
  const offNav = useNav.subscribe(() => {
    const s = useEditUi.getState();
    const top = topView();
    if (s.batch !== null && !(top.kind === "single" && top.source === "selection")) {
      exitBatch();
      return;
    }
    if (s.status === "idle") return;
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
    if (s.batch !== null) exitBatch();
    else s.close();
    showToast({ text: t("edit.toast.sourceChanged") });
  });
  return () => {
    offCatalog();
    offNav();
  };
}

/** 页面卸下（重载、关窗）时关掉编辑会话，后端早些放下解码好的大图。保存进行中不关：让后端把这次保存做完。 */
function closeOnPageHide(): () => void {
  const onHide = () => {
    const { status } = useEditUi.getState();
    if (status === "ready" || status === "opening") useEditUi.getState().close();
  };
  window.addEventListener("pagehide", onHide);
  return () => window.removeEventListener("pagehide", onHide);
}

/** 应用启动时注册一次：编辑命令（按视图生效）与编辑会话的收尾监听；返回注销函数。 */
export function registerEditCommands(): () => void {
  const off = registerCommands(editCommands);
  const unwatch = watchEditSource();
  const unhide = closeOnPageHide();
  return () => {
    unhide();
    unwatch();
    off();
  };
}
