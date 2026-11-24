import { useRef } from "react";
import { t } from "../../i18n";
import { useTip } from "../../stores/tip";
import { useModalFocus } from "../common/useModalFocus";
import alipay from "../../assets/tip/alipay.png";
import board from "../../assets/tip/tiger_board.webp";
import wechat from "../../assets/tip/wechat.png";
import "./tip.css";

const close = () => useTip.setState({ open: false });

/** 打赏面板：开合存在 store 里；Esc 由 useKeyboard 统一处理，焦点陷阱用 useModalFocus。 */
export default function TipDialog() {
  const open = useTip((s) => s.open);
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel, open);
  if (!open) return null;

  return (
    <div className="tip-backdrop" onClick={close}>
      <div
        ref={panel}
        className="tip-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("tip.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="tip-title">{t("tip.title")}</h2>
        <p className="tip-body">{t("tip.body")}</p>
        <div className="tip-art">
          <img className="tip-board" src={board} alt="" draggable={false} />
          {/* 二维码叠在插画看板的空白区里；区域位置按原图 1024 px 量出 */}
          <div className="tip-slot">
            <figure className="tip-code">
              <img src={wechat} alt={t("tip.wechat")} draggable={false} />
              <figcaption>{t("tip.wechat")}</figcaption>
            </figure>
            <figure className="tip-code">
              <img src={alipay} alt={t("tip.alipay")} draggable={false} />
              <figcaption>{t("tip.alipay")}</figcaption>
            </figure>
          </div>
        </div>
        <div className="tip-actions">
          <button type="button" onClick={close}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
