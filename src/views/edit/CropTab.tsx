import { useState, type MouseEvent } from "react";
import { t, type MessageKey } from "../../i18n";
import type { CropMemory, CropRatio, CropState } from "../../ipc/types";
import { fitRatio, flip, orientedSize, ratioOf, resizeTo, rotate } from "../../lib/cropGeometry";
import { useEditUi } from "../../stores/editUi";

/** 按下不把焦点移到按钮上：焦点留在页面，回车仍是“保存”命令。 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

const RATIOS: { key: CropRatio; label: MessageKey | string }[] = [
  { key: "free", label: "edit.crop.free" },
  { key: "1:1", label: "1:1" },
  { key: "4:3", label: "4:3" },
  { key: "16:9", label: "16:9" },
  { key: "custom", label: "edit.crop.custom" },
];
const labelOf = (l: MessageKey | string) => (l.startsWith("edit.") ? t(l as MessageKey) : l);

/** 横竖互换只对非正方形的固定比例有意义。 */
const swappable = (r: CropRatio) => r === "4:3" || r === "16:9" || r === "custom";

const CUSTOM_MAX = 9999;

/** 当前裁剪状态与原图尺寸（只在编辑已就绪时调用）。 */
function current(): { cs: CropState; dims: { w: number; h: number } } | null {
  const s = useEditUi.getState();
  if (!s.cropState || !s.opened) return null;
  return { cs: s.cropState, dims: { w: s.opened.width, h: s.opened.height } };
}

/** 改比例记忆；比例固定时在当前框中心放下该比例下能放进图片的最大框。 */
function setRatio(partial: Partial<CropMemory>) {
  const store = useEditUi.getState();
  store.patch("crop", partial);
  const cur = current();
  const ratio = ratioOf(useEditUi.getState().crop);
  if (!cur || ratio === null) return;
  const bounds = orientedSize(cur.dims.w, cur.dims.h, cur.cs.quarterTurns);
  store.setCropState({ ...cur.cs, rect: fitRatio(cur.cs.rect, ratio, bounds) });
}

/** 宽高输入接受的上限：超出图片的由 resizeTo 夹到最大。 */
const DIM_LIMIT = 65535;

/**
 * 正整数输入：输入中允许空和越界，只有 1..limit 的整数才交给 onValid；失焦后显示回当前值。
 * 未在输入时显示 value，所以框被拖动、旋转或另一边联动后显示新值。
 */
function IntInput({ value, label, max, limit = max, onValid }: {
  value: number; label: string; max: number; limit?: number; onValid(n: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      className="edit-number crop-number"
      aria-label={label}
      min={1}
      max={max}
      step={1}
      value={text ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = Number(raw);
        if (raw !== "" && Number.isInteger(n) && n >= 1 && n <= limit) onValid(n);
      }}
      onBlur={() => setText(null)}
    />
  );
}

function ActionButton({ label, onClick }: { label: MessageKey; onClick(): void }) {
  return (
    <button type="button" className="crop-action" onMouseDown={keepFocus} onClick={onClick}>
      {t(label)}
    </button>
  );
}

/** 裁剪页：比例预设（含自定义与横竖互换）、宽高像素输入、旋转翻转与还原。画面上的裁剪框在 CropStage。 */
export default function CropTab() {
  const mem = useEditUi((s) => s.crop);
  const cs = useEditUi((s) => s.cropState);
  const opened = useEditUi((s) => s.opened);
  if (!cs || !opened) return null;
  const dims = { w: opened.width, h: opened.height };
  const bounds = orientedSize(dims.w, dims.h, cs.quarterTurns);
  const set = (next: CropState) => useEditUi.getState().setCropState(next);
  const resize = (w: number | null, h: number | null) => {
    const cur = current();
    if (!cur) return;
    const b = orientedSize(cur.dims.w, cur.dims.h, cur.cs.quarterTurns);
    set({ ...cur.cs, rect: resizeTo(cur.cs.rect, w, h, ratioOf(useEditUi.getState().crop), b) });
  };
  const transform = (fn: (s: CropState, d: { w: number; h: number }) => CropState) => {
    const cur = current();
    if (cur) set(fn(cur.cs, cur.dims));
  };

  return (
    <div className="edit-tab-body">
      <div className="edit-row">
        <span className="edit-label">{t("edit.crop.ratio")}</span>
        <div className="crop-ratios" role="group" aria-label={t("edit.crop.ratio")}>
          {RATIOS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`crop-ratio${mem.ratio === key ? " is-active" : ""}`}
              aria-pressed={mem.ratio === key}
              onMouseDown={keepFocus}
              onClick={() => setRatio({ ratio: key })}
            >
              {labelOf(label)}
            </button>
          ))}
          <button
            type="button"
            className={`crop-swap${mem.portrait ? " is-active" : ""}`}
            aria-label={t("edit.crop.swap")}
            title={t("edit.crop.swap")}
            aria-pressed={mem.portrait}
            disabled={!swappable(mem.ratio)}
            onMouseDown={keepFocus}
            onClick={() => setRatio({ portrait: !useEditUi.getState().crop.portrait })}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="2" y="5" width="9" height="6" rx="1" />
              <path d="M13 3v8M11 5l2-2 2 2" />
            </svg>
          </button>
        </div>
      </div>
      {mem.ratio === "custom" && (
        <div className="edit-row crop-custom">
          <span className="edit-label" />
          <IntInput
            value={mem.customW}
            label={t("edit.crop.customW")}
            max={CUSTOM_MAX}
            onValid={(customW) => setRatio({ customW })}
          />
          <span className="edit-unit">:</span>
          <IntInput
            value={mem.customH}
            label={t("edit.crop.customH")}
            max={CUSTOM_MAX}
            onValid={(customH) => setRatio({ customH })}
          />
        </div>
      )}
      <div className="edit-row">
        <span className="edit-label">{t("edit.crop.size")}</span>
        <span className="crop-dims">
          <IntInput value={cs.rect.w} label={t("edit.crop.width")} max={bounds.w} limit={DIM_LIMIT} onValid={(w) => resize(w, null)} />
          <span className="edit-unit">×</span>
          <IntInput value={cs.rect.h} label={t("edit.crop.height")} max={bounds.h} limit={DIM_LIMIT} onValid={(h) => resize(null, h)} />
        </span>
      </div>
      <div className="edit-row">
        <span className="edit-label">{t("edit.crop.transform")}</span>
        <div className="crop-actions">
          <ActionButton label="edit.crop.rotateLeft" onClick={() => transform((s, d) => rotate(s, -1, d))} />
          <ActionButton label="edit.crop.rotateRight" onClick={() => transform((s, d) => rotate(s, 1, d))} />
          <ActionButton label="edit.crop.flipH" onClick={() => transform((s, d) => flip(s, "h", d))} />
          <ActionButton label="edit.crop.flipV" onClick={() => transform((s, d) => flip(s, "v", d))} />
        </div>
      </div>
      <div className="edit-row">
        <ActionButton
          label="edit.crop.reset"
          onClick={() => set({ rect: { x: 0, y: 0, w: dims.w, h: dims.h }, quarterTurns: 0, flipH: false, flipV: false })}
        />
      </div>
    </div>
  );
}
