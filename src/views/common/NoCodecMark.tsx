import { t } from "../../i18n";
import "./noCodec.css";

/**
 * 缩略图位置的“缺系统解码组件”占位：图片轮廓加一个小插头，与损坏的占位区分开。
 * className 给出各处自己的尺寸与底色（网格、缩略图条、对比格、对比面板）。
 */
export default function NoCodecMark({ className }: { className: string }) {
  return (
    <div className={`no-codec ${className}`} title={t("codec.thumbTip")} role="img" aria-label={t("codec.thumbTip")}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 15l4-4 3 3 2-2 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 21v-3M14 21v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}
