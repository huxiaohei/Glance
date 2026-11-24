import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { dismissToast, useToast } from "../../stores/toast";
import "./toast.css";

/** 非 busy 的提示显示这么久后消失。 */
const TOAST_MS = 5000;

/** 窗口底部居中的全局提示条，一次一条。 */
export default function Toast() {
  const current = useToast((s) => s.current);
  const key = current?.key;
  const busy = current?.busy ?? false;
  const sticky = current?.sticky ?? false;
  const [hover, setHover] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // 换了一条：悬停与展开状态不带过去
  useEffect(() => {
    setHover(false);
    setExpanded(false);
  }, [key]);

  // 悬停或展开状态一变就重新计一个完整的 5 秒
  useEffect(() => {
    if (key === undefined || busy || sticky || hover || expanded) return;
    const timer = setTimeout(() => dismissToast(key), TOAST_MS);
    return () => clearTimeout(timer);
  }, [key, busy, sticky, hover, expanded]);

  if (current === null) return null;
  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div className="toast-row">
        <span className="toast-text">{current.text}</span>
        {current.details && current.details.length > 0 && (
          <button
            type="button"
            className="toast-btn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {t("toast.details")}
          </button>
        )}
        {current.actions?.map((a) => (
          <button
            key={a.label}
            type="button"
            className="toast-btn"
            onClick={() => {
              try {
                a.run();
              } finally {
                dismissToast(current.key);
              }
            }}
          >
            {a.label}
          </button>
        ))}
        {!busy && (
          <button
            type="button"
            className="toast-btn toast-close"
            aria-label={t("toast.close")}
            onClick={() => dismissToast(current.key)}
          >
            ×
          </button>
        )}
      </div>
      {expanded && current.details && (
        <ul className="toast-details">
          {current.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
