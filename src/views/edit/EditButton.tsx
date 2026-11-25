import { allCommands } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { useAnimated } from "../../stores/animated";
import { useEditUi } from "../../stores/editUi";
import { enterEdit } from "./editCommands";
import "./edit.css";

/** 指针按下不把焦点移到按钮上（否则回车会再次触发它）。 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/** 单张视图顶栏的“编辑”按钮：已知是动图时置灰并提示“动图暂不支持编辑”；编辑中高亮。 */
export default function EditButton({ id }: { id: FileId }) {
  const editing = useEditUi((s) => s.status !== "idle" && s.id === id);
  const animated = useAnimated((s) => s.ids.has(id));
  const cmd = allCommands().find((c) => c.id === "edit.open");
  const tip = animated
    ? t("edit.button.animated")
    : cmd ? `${t(cmd.title)} (${formatKey(cmd.keys[0], IS_MAC)})` : t("edit.button");
  return (
    <button
      type="button"
      className={`topbar-edit${editing ? " active" : ""}`}
      title={tip}
      aria-label={t("edit.button")}
      aria-pressed={editing}
      // 不用 disabled：禁用的按钮在有的引擎里不显示 title 提示
      aria-disabled={animated}
      onMouseDown={keepFocus}
      onClick={() => {
        if (!animated && useEditUi.getState().status === "idle") void enterEdit(id);
      }}
    >
      {t("edit.button")}
    </button>
  );
}
