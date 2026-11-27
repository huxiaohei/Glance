import { allCommands } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { useAnimated } from "../../stores/animated";
import { useEditUi } from "../../stores/editUi";
import { useThumbs } from "../../stores/thumbs";
import { enterEdit } from "./editCommands";
import "./edit.css";

/** 指针按下不把焦点移到按钮上（否则回车会再次触发它）。 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/** 单张视图顶栏的“编辑”按钮：已知是动图、或本机缺系统解码组件时置灰并说明原因；编辑中高亮。 */
export default function EditButton({ id }: { id: FileId }) {
  const editing = useEditUi((s) => s.status !== "idle" && s.id === id);
  const animated = useAnimated((s) => s.ids.has(id));
  const noCodec = useThumbs((s) => s.noCodec.has(id));
  const blocked = animated || noCodec;
  const cmd = allCommands().find((c) => c.id === "edit.open");
  const tip = noCodec
    ? t("codec.editTip")
    : animated
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
      aria-disabled={blocked}
      onMouseDown={keepFocus}
      onClick={() => {
        if (!blocked && useEditUi.getState().status === "idle") void enterEdit(id);
      }}
    >
      {t("edit.button")}
    </button>
  );
}
