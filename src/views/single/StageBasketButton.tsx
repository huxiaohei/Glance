import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { useBasket } from "../../stores/basket";

/** 单张视图画面右上角：加入 / 移出对比；已在篮内时实心琥珀色。 */
export default function StageBasketButton({ id }: { id: FileId }) {
  const inBasket = useBasket((s) => s.items.has(id));
  return (
    <button
      type="button"
      className={`stage-basket-btn${inBasket ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => useBasket.getState().toggle([id])}
    >
      {t(inBasket ? "basket.remove" : "basket.add")}
    </button>
  );
}
