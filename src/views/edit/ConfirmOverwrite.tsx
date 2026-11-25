import { useRef } from "react";
import { saveEdit } from "../../app/editSave";
import { t } from "../../i18n";
import { closeConfirmOverwrite, useConfirmOverwrite } from "../../stores/confirmOverwrite";
import { useEditUi } from "../../stores/editUi";
import { useModalFocus } from "../common/useModalFocus";

/**
 * 默认是“保存副本”而从下拉里临时选了“覆盖原图”时弹出：写明原图进废纸篓、可撤销。
 * 键盘：Esc 关闭（useKeyboard 里处理），Tab 在对话框内循环，回车 / 空格按下聚焦的按钮。
 */
export default function ConfirmOverwrite() {
  const open = useConfirmOverwrite((s) => s.open);
  const ready = useEditUi((s) => s.status === "ready");
  const shown = open && ready;
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box, shown);
  if (!shown) return null;

  const confirm = () => {
    closeConfirmOverwrite();
    void saveEdit({ kind: "overwrite" });
  };

  return (
    <div className="edit-confirm-backdrop" onClick={closeConfirmOverwrite}>
      <div
        ref={box}
        className="edit-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-confirm-title"
        aria-describedby="edit-confirm-body"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-confirm-title" className="edit-confirm-title">{t("edit.confirm.title")}</h2>
        <p id="edit-confirm-body" className="edit-confirm-body">{t("edit.confirm.body")}</p>
        <div className="edit-confirm-actions">
          <button type="button" onClick={closeConfirmOverwrite}>{t("edit.confirm.cancel")}</button>
          <button type="button" className="edit-primary edit-danger" onClick={confirm}>{t("edit.confirm.ok")}</button>
        </div>
      </div>
    </div>
  );
}
