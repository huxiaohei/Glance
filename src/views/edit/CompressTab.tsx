import { useState } from "react";
import { t } from "../../i18n";
import { compressUnsupported, useEditUi } from "../../stores/editUi";

const MAX_EDGE_MIN = 1;
const MAX_EDGE_MAX = 65535;

/** 质量滑块：拖动即改参数（预览由 store 的调度器发出）。 */
export function QualitySlider({ value, disabled, onChange }: { value: number; disabled: boolean; onChange(v: number): void }) {
  return (
    <div className="edit-row">
      <label htmlFor="edit-quality">{t("edit.quality")}</label>
      <input
        id="edit-quality"
        type="range"
        min={1}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="edit-value">{value}</span>
    </div>
  );
}

/** 最长边像素输入：输入中允许空和越界，只有 1–65535 的整数才写进参数；失焦后显示回有效值。 */
function MaxEdgeInput({ value, disabled }: { value: number; disabled: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      className="edit-number"
      aria-label={t("edit.maxEdge.value")}
      min={MAX_EDGE_MIN}
      max={MAX_EDGE_MAX}
      step={1}
      value={text ?? String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = Number(raw);
        if (raw !== "" && Number.isInteger(n) && n >= MAX_EDGE_MIN && n <= MAX_EDGE_MAX) {
          useEditUi.getState().patch("compress", { maxEdge: n });
        }
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** 压缩页：质量、限制最长边；原图为 PNG 时多“有损 / 无损”，无损时滑块禁用。GIF / BMP 只显示不支持的说明。 */
export default function CompressTab() {
  const c = useEditUi((s) => s.compress);
  const srcFormat = useEditUi((s) => s.opened?.srcFormat);
  const unsupported = useEditUi(compressUnsupported);
  if (unsupported) return <p className="edit-note">{t("edit.compress.unsupported")}</p>;
  const patch = useEditUi.getState().patch;
  const isPng = srcFormat === "png";
  const lossless = isPng && c.pngMode === "lossless";

  return (
    <div className="edit-tab-body">
      {isPng && (
        <div className="edit-row" role="radiogroup" aria-label={t("edit.pngMode")}>
          <span className="edit-label">{t("edit.pngMode")}</span>
          <div className="edit-choices">
            {(["lossy", "lossless"] as const).map((m) => (
              <label key={m} className="edit-choice">
                <input
                  type="radio"
                  name="edit-png-mode"
                  checked={c.pngMode === m}
                  onChange={() => patch("compress", { pngMode: m })}
                />
                {t(m === "lossy" ? "edit.pngMode.lossy" : "edit.pngMode.lossless")}
              </label>
            ))}
          </div>
        </div>
      )}
      <QualitySlider value={c.quality} disabled={lossless} onChange={(quality) => patch("compress", { quality })} />
      <div className="edit-row">
        <label className="edit-choice">
          <input type="checkbox" checked={c.maxEdgeOn} onChange={(e) => patch("compress", { maxEdgeOn: e.target.checked })} />
          {t("edit.maxEdge")}
        </label>
        <span className="edit-edge">
          <MaxEdgeInput value={c.maxEdge} disabled={!c.maxEdgeOn} />
          <span className="edit-unit">{t("edit.maxEdge.unit")}</span>
        </span>
      </div>
    </div>
  );
}
