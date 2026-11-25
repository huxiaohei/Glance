import { t } from "../../i18n";
import type { OutFormat } from "../../ipc/types";
import { useEditUi } from "../../stores/editUi";
import { QualitySlider } from "./CompressTab";

/** 格式名是专有名词，不翻译。 */
export const FORMAT_LABEL: Record<string, string> = { png: "PNG", jpeg: "JPG", webp: "WebP", gif: "GIF", bmp: "BMP" };

const FORMATS: OutFormat[] = ["png", "jpeg", "webp"];
const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);
const toHex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
function fromHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** 转格式页：目标格式、质量（PNG 时禁用）；目标为 JPG 且原图有透明通道时出现背景填充色。 */
export default function ConvertTab() {
  const v = useEditUi((s) => s.convert);
  const hasAlpha = useEditUi((s) => s.opened?.hasAlpha === true);
  const patch = useEditUi.getState().patch;
  const custom = !same(v.fill, WHITE) && !same(v.fill, BLACK);

  return (
    <div className="edit-tab-body">
      <div className="edit-row" role="radiogroup" aria-label={t("edit.format")}>
        <span className="edit-label">{t("edit.format")}</span>
        <div className="edit-choices">
          {FORMATS.map((f) => (
            <label key={f} className="edit-choice">
              <input type="radio" name="edit-format" checked={v.format === f} onChange={() => patch("convert", { format: f })} />
              {FORMAT_LABEL[f]}
            </label>
          ))}
        </div>
      </div>
      <QualitySlider value={v.quality} disabled={v.format === "png"} onChange={(quality) => patch("convert", { quality })} />
      {v.format === "jpeg" && hasAlpha && (
        <div className="edit-row" role="radiogroup" aria-label={t("edit.fill")}>
          <span className="edit-label">{t("edit.fill")}</span>
          <div className="edit-choices">
            <label className="edit-choice">
              <input type="radio" name="edit-fill" checked={same(v.fill, WHITE)} onChange={() => patch("convert", { fill: WHITE })} />
              {t("edit.fill.white")}
            </label>
            <label className="edit-choice">
              <input type="radio" name="edit-fill" checked={same(v.fill, BLACK)} onChange={() => patch("convert", { fill: BLACK })} />
              {t("edit.fill.black")}
            </label>
            <label className={`edit-choice edit-custom${custom ? " is-active" : ""}`} title={t("edit.fill.custom")}>
              <input
                type="color"
                aria-label={t("edit.fill.custom")}
                value={toHex(v.fill)}
                onChange={(e) => {
                  const rgb = fromHex(e.target.value);
                  if (rgb) patch("convert", { fill: rgb });
                }}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
