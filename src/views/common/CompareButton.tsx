import { t } from "../../i18n";
import { useBasket } from "../../stores/basket";
import { useNav } from "../../stores/nav";

/** 指针按下不把焦点移到按钮上（否则空格会再次激活它）；点击照常触发。 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/** “对比 · N”：篮空时禁用；点击进入对比。网格工具栏与单张顶栏共用。 */
export default function CompareButton() {
  const n = useBasket((s) => s.order.length);
  return (
    <button
      type="button"
      className="compare-btn"
      disabled={n === 0}
      onMouseDown={keepFocus}
      onClick={() => useNav.getState().openCompare()}
    >
      {t("basket.button", { n })}
    </button>
  );
}
