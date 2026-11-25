import type { MouseEvent } from "react";
import { t, type MessageKey } from "../../i18n";
import type { CompareBackground } from "../../ipc/types";
import { useBasket } from "../../stores/basket";
import { useCompareUi } from "../../stores/compareUi";
import { useNav } from "../../stores/nav";
import { updateSettings, useSettings } from "../../stores/settings";

/** 按下按钮不拿焦点：焦点留在页面上，方向键、Esc 等仍走命令表。 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

const COLUMNS = [2, 3, 4, 5, 6, 7, 8];
const BACKGROUNDS: { value: CompareBackground; label: MessageKey }[] = [
  { value: "dark", label: "compare.bg.dark" },
  { value: "light", label: "compare.bg.light" },
  { value: "checker", label: "compare.bg.checker" },
];

/** 清空并返回进入前的视图（撤销提示条由任务 8 补上）。 */
function clearAndBack(): void {
  useBasket.getState().clear();
  useNav.getState().back();
}

/** 对比视图顶栏：返回、标题、每排张数、同步缩放、背景、说明开关、清空。 */
export default function CompareTopBar({ count }: { count: number }) {
  const columns = useSettings((s) => s.settings.compareColumns);
  const bg = useSettings((s) => s.settings.compareBackground);
  const sync = useCompareUi((s) => s.perCell === null);
  const captions = useCompareUi((s) => s.captions);

  return (
    <div className="compare-topbar">
      <button
        type="button"
        className="compare-back"
        aria-label={t("compare.back")}
        title={t("compare.back")}
        onMouseDown={keepFocus}
        onClick={() => useNav.getState().back()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        <span>{t("compare.back")}</span>
      </button>
      <span className="compare-title">{t("compare.title", { n: count })}</span>
      <span className="compare-spacer" />
      <select
        aria-label={t("compare.columnsLabel")}
        value={columns}
        onChange={(e) => {
          updateSettings({ compareColumns: Number(e.target.value) });
          // 下拉框留着焦点时按键都当作在输入框里，Esc 等命令不响应
          e.currentTarget.blur();
        }}
      >
        {COLUMNS.map((n) => (
          <option key={n} value={n}>
            {t("compare.columns", { n })}
          </option>
        ))}
      </select>
      <label className="compare-switch" onMouseDown={keepFocus}>
        <span>{t("compare.sync")}</span>
        <input
          type="checkbox"
          role="switch"
          checked={sync}
          onChange={() => useCompareUi.getState().toggleSync()}
        />
      </label>
      <span className="compare-bg" role="group" aria-label={t("compare.bg")}>
        <span className="compare-bg-label">{t("compare.bg")}</span>
        {BACKGROUNDS.map((b) => (
          <button
            key={b.value}
            type="button"
            className={`compare-swatch compare-swatch-${b.value}`}
            aria-label={t(b.label)}
            title={t(b.label)}
            aria-pressed={bg === b.value}
            onMouseDown={keepFocus}
            onClick={() => updateSettings({ compareBackground: b.value })}
          />
        ))}
      </span>
      <button
        type="button"
        className="compare-captions"
        aria-pressed={captions}
        onMouseDown={keepFocus}
        onClick={() => useCompareUi.getState().toggleCaptions()}
      >
        {t("compare.captions")}
      </button>
      <button type="button" className="compare-clear" onMouseDown={keepFocus} onClick={clearAndBack}>
        {t("compare.clear")}
      </button>
    </div>
  );
}
