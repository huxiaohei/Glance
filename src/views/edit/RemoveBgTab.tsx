import { t, type MessageKey } from "../../i18n";
import type { RemoveBgMemory } from "../../ipc/types";
import { useEditUi } from "../../stores/editUi";

const hex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** 一行滑块：拖动即改参数（预览由 store 的调度器发出）。 */
function Slider({ id, label, min, max, value, onChange }: {
  id: string; label: MessageKey; min: number; max: number; value: number; onChange(v: number): void;
}) {
  return (
    <div className="edit-row">
      <label htmlFor={id}>{t(label)}</label>
      <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="edit-value">{value}</span>
    </div>
  );
}

/**
 * 去背景页：方式（alpha 阈值 / 按颜色）。alpha 阈值：0–255 与“低于 / 高于阈值”；原图没有透明像素时此方式禁用。
 * 按颜色：当前背景色（在画面上单击取色）、容差、边缘柔化、“只去掉与边缘连通的区域”。
 */
export default function RemoveBgTab() {
  const r = useEditUi((s) => s.removeBg);
  const hasAlpha = useEditUi((s) => s.opened?.hasAlpha === true);
  const bgColor = useEditUi((s) => s.bgColor);
  const patch = (partial: Partial<RemoveBgMemory>) => useEditUi.getState().patch("removeBg", partial);
  const setMode = (mode: RemoveBgMemory["mode"]) => {
    if (r.mode === mode || (mode === "alpha" && !hasAlpha)) return;
    patch({ mode });
  };

  return (
    <div className="edit-tab-body">
      <div className="edit-row" role="radiogroup" aria-label={t("edit.removeBg.mode")}>
        <span className="edit-label">{t("edit.removeBg.mode")}</span>
        <div className="edit-choices">
          <label className={`edit-choice${hasAlpha ? "" : " is-disabled"}`}>
            <input
              type="radio"
              name="edit-removebg-mode"
              checked={r.mode === "alpha"}
              disabled={!hasAlpha}
              onChange={() => setMode("alpha")}
            />
            {t("edit.removeBg.mode.alpha")}
          </label>
          <label className="edit-choice">
            <input type="radio" name="edit-removebg-mode" checked={r.mode === "color"} onChange={() => setMode("color")} />
            {t("edit.removeBg.mode.color")}
          </label>
        </div>
        {!hasAlpha && <p className="edit-note">{t("edit.removeBg.noAlpha")}</p>}
      </div>
      {r.mode === "alpha" ? (
        <>
          <Slider
            id="edit-removebg-threshold"
            label="edit.removeBg.threshold"
            min={0}
            max={255}
            value={r.threshold}
            onChange={(threshold) => patch({ threshold })}
          />
          <div className="edit-row" role="radiogroup" aria-label={t("edit.removeBg.direction")}>
            <span className="edit-label">{t("edit.removeBg.direction")}</span>
            <div className="edit-choices">
              {([true, false] as const).map((below) => (
                <label key={String(below)} className="edit-choice">
                  <input
                    type="radio"
                    name="edit-removebg-below"
                    checked={r.below === below}
                    onChange={() => patch({ below })}
                  />
                  {t(below ? "edit.removeBg.below" : "edit.removeBg.above")}
                </label>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="edit-row">
            <span className="edit-label">{t("edit.removeBg.color")}</span>
            <span className="edit-bg-color">
              {bgColor && (
                <>
                  <span className="edit-swatch" style={{ backgroundColor: `rgb(${bgColor.join(", ")})` }} aria-hidden="true" />
                  <span className="edit-hex">{hex(bgColor)}</span>
                </>
              )}
            </span>
            <p className="edit-note">{t("edit.removeBg.pickHint")}</p>
          </div>
          <Slider
            id="edit-removebg-tolerance"
            label="edit.removeBg.tolerance"
            min={0}
            max={100}
            value={r.tolerance}
            onChange={(tolerance) => patch({ tolerance })}
          />
          <Slider
            id="edit-removebg-softness"
            label="edit.removeBg.softness"
            min={0}
            max={100}
            value={r.softness}
            onChange={(softness) => patch({ softness })}
          />
          <div className="edit-row">
            <label className="edit-choice">
              <input type="checkbox" checked={r.edgeConnected} onChange={(e) => patch({ edgeConnected: e.target.checked })} />
              {t("edit.removeBg.edgeConnected")}
            </label>
          </div>
        </>
      )}
    </div>
  );
}
