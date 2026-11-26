import { useEffect, useRef, type MouseEvent } from "react";
import { exitBatch, runBatch } from "../../app/batchMode";
import { saveEdit } from "../../app/editSave";
import { t } from "../../i18n";
import { compressUnsupported, cropUnchanged, useEditUi } from "../../stores/editUi";
import { useSettings } from "../../stores/settings";
import { useConfirmOverwrite } from "../../stores/confirmOverwrite";
import { setSaveMenuOpen, useSaveMenu } from "../../stores/saveMenu";
import { exitEdit } from "./editCommands";

/** 按下不把焦点移到按钮上：焦点留在页面，回车仍是“保存”命令，不会再点一次按钮。 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** 批量模式的底部按钮：只有“处理 N 张”一个主按钮（清单未到时“处理…”，N 为 0 时禁用）与“取消”（回网格）。 */
function BatchSaveBar() {
  const n = useEditUi((s) => s.batch?.plan?.process.length ?? null);
  return (
    <div className="edit-savebar">
      <button
        type="button"
        className="edit-primary edit-batch-run"
        disabled={n === null || n === 0}
        onMouseDown={keepFocus}
        onClick={() => void runBatch()}
      >
        {n === null ? t("edit.batch.processPending") : t("edit.batch.process", { n })}
      </button>
      <button type="button" className="edit-cancel" onMouseDown={keepFocus} onClick={exitBatch}>
        {t("edit.cancel")}
      </button>
    </div>
  );
}

export default function SaveBar() {
  const batch = useEditUi((s) => s.batch !== null);
  return batch ? <BatchSaveBar /> : <SingleSaveBar />;
}

/**
 * 底部按钮：主按钮按设置（保存副本 / 覆盖原图）；下拉里是另一项与“另存到其他位置…”；“取消”。
 * 只有默认是保存副本、从下拉临时选“覆盖原图”时先弹确认。保存进行中全部禁用，主按钮显示进行中。
 * 裁剪页未做任何改动时禁用并给出提示。
 */
function SingleSaveBar() {
  const mode = useSettings((s) => s.settings.editSaveMode);
  const status = useEditUi((s) => s.status);
  const unsupported = useEditUi(compressUnsupported);
  const unchanged = useEditUi(cropUnchanged);
  const menuOpen = useSaveMenu((s) => s.open);
  const setMenuOpen = setSaveMenuOpen;
  const root = useRef<HTMLDivElement>(null);
  const saving = status === "saving";
  const disabled = status !== "ready" || unsupported || unchanged;

  // 卸下（退出编辑）时收起
  useEffect(() => () => setSaveMenuOpen(false), []);

  // 点下拉之外的地方收起
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const pick = (run: () => void) => {
    setMenuOpen(false);
    run();
  };
  const other =
    mode === "copy"
      ? { label: t("edit.save.overwrite"), run: () => useConfirmOverwrite.setState({ open: true }) }
      : { label: t("edit.save.copy"), run: () => void saveEdit({ kind: "copy" }) };

  return (
    <>
      {unchanged && <p className="edit-note edit-unchanged">{t("edit.crop.unchanged")}</p>}
      <div className="edit-savebar" ref={root}>
        <div className="edit-split">
          <button
            type="button"
            className="edit-primary"
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => void saveEdit()}
          >
            {saving ? t("edit.save.saving") : t(mode === "overwrite" ? "edit.save.overwrite" : "edit.save.copy")}
          </button>
          <button
            type="button"
            className="edit-primary edit-more"
            aria-label={t("edit.save.more")}
            title={t("edit.save.more")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M2 4l4 4 4-4" />
            </svg>
          </button>
          {menuOpen && !disabled && (
            <div className="edit-menu" role="menu">
              <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={() => pick(other.run)}>
                {other.label}
              </button>
              <button
                type="button"
                role="menuitem"
                onMouseDown={keepFocus}
                onClick={() => pick(() => void saveEdit({ kind: "saveAs", path: "" }))}
              >
                {t("edit.save.as")}
              </button>
            </div>
          )}
        </div>
        <button type="button" className="edit-cancel" disabled={saving} onMouseDown={keepFocus} onClick={exitEdit}>
          {t("edit.cancel")}
        </button>
      </div>
    </>
  );
}
