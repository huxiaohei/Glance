import { useEffect, type MouseEvent } from "react";
import { t, type MessageKey } from "../../i18n";
import type { EditTab } from "../../ipc/types";
import { compressUnsupported, useEditUi } from "../../stores/editUi";
import CompressTab from "./CompressTab";
import { closeConfirmOverwrite } from "../../stores/confirmOverwrite";
import ConfirmOverwrite from "./ConfirmOverwrite";
import ConvertTab from "./ConvertTab";
import CropTab from "./CropTab";
import RemoveBgTab from "./RemoveBgTab";
import SaveBar from "./SaveBar";
import SizeFooter from "./SizeFooter";
import "./edit.css";

const keepFocus = (e: MouseEvent) => e.preventDefault();

/** 四个页签，顺序固定。 */
const TABS: { key: EditTab; label: MessageKey }[] = [
  { key: "compress", label: "edit.tab.compress" },
  { key: "crop", label: "edit.tab.crop" },
  { key: "removeBg", label: "edit.tab.removeBg" },
  { key: "convert", label: "edit.tab.convert" },
];

function TabBody({ tab }: { tab: EditTab }) {
  switch (tab) {
    case "compress": return <CompressTab />;
    case "crop": return <CropTab />;
    case "removeBg": return <RemoveBgTab />;
    case "convert": return <ConvertTab />;
  }
}

/** 面板里的错误：保存失败的原因优先，其次是预览失败（压缩不支持时不算，已有说明）。仍允许保存：后端会自己算全尺寸。 */
function ErrorLine() {
  const saveError = useEditUi((s) => s.saveError);
  const previewError = useEditUi((s) => s.previewError);
  const unsupported = useEditUi(compressUnsupported);
  const text = saveError ?? (previewError !== null && !unsupported ? t("edit.err.preview") : null);
  if (text === null) return null;
  return (
    <p className="edit-error" role="alert">
      {text}
    </p>
  );
}

/** “按住查看原图”：按住期间画面换回原图，松开、移出或被打断时恢复。 */
function HoldOriginal() {
  const set = (b: boolean) => useEditUi.getState().setShowOriginal(b);
  return (
    <button
      type="button"
      className="edit-hold"
      onMouseDown={keepFocus}
      onPointerDown={() => set(true)}
      onPointerUp={() => set(false)}
      onPointerLeave={() => set(false)}
      onPointerCancel={() => set(false)}
    >
      {t("edit.holdOriginal")}
    </button>
  );
}

/** 编辑参数面板：单张视图右侧 280 px，滑入；页签、参数、体积对比、保存按钮。 */
export default function EditPanel() {
  const opened = useEditUi((s) => s.opened !== null);
  const tab = useEditUi((s) => s.tab);
  const loading = useEditUi((s) => s.status === "opening");

  // 面板收起（退出编辑）时一并关掉覆盖确认，松开“按住查看原图”
  useEffect(
    () => () => {
      closeConfirmOverwrite();
      useEditUi.getState().setShowOriginal(false);
    },
    [],
  );

  if (!opened) {
    // 正在读取、解码：先给出面板与提示，免得右侧空着
    if (!loading) return null;
    return (
      <aside className="edit-panel" aria-label={t("edit.panel")}>
        <p className="edit-loading" role="status">
          {t("edit.loading")}
        </p>
      </aside>
    );
  }
  return (
    <aside className="edit-panel" aria-label={t("edit.panel")}>
      <div className="edit-tabs" role="tablist">
        {TABS.map(({ key, label }) => (
          <button
            key={label}
            type="button"
            role="tab"
            className={`edit-tab${key === tab ? " is-active" : ""}`}
            aria-selected={key === tab}
            onMouseDown={keepFocus}
            onClick={() => useEditUi.getState().setTab(key)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="edit-body">
        <TabBody tab={tab} />
      </div>
      <ErrorLine />
      <div className="edit-foot">
        {tab !== "crop" && <HoldOriginal />}
        <SizeFooter />
        <SaveBar />
      </div>
      <ConfirmOverwrite />
    </aside>
  );
}
