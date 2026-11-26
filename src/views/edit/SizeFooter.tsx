import { t } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import { compressUnsupported, useEditUi } from "../../stores/editUi";
import { FORMAT_LABEL } from "./ConvertTab";

/**
 * 面板底部的体积对比：`原 格式 · 大小 → 新 格式 · （约）大小`；裁剪页两侧前面加 `宽×高`。压缩时加“节省 xx%”；
 * 结果比原图大时（压缩、转格式都算）标“变大 xx%”，整行加 is-larger。全尺寸结果到达前大小带“约”。
 */
export default function SizeFooter() {
  const opened = useEditUi((s) => s.opened);
  const result = useEditUi((s) => s.result);
  const tab = useEditUi((s) => s.tab);
  const unsupported = useEditUi(compressUnsupported);
  if (!opened) return null;

  const crop = tab === "crop";
  const src = `${crop ? `${opened.width}×${opened.height} · ` : ""}${FORMAT_LABEL[opened.srcFormat]} · ${formatBytes(opened.fileSize)}`;
  const r = unsupported ? null : result;
  let out = t("edit.size.computing");
  let delta: string | null = null;
  let larger = false;
  if (r) {
    const size = formatBytes(r.bytes);
    out = `${crop ? `${r.width}×${r.height} · ` : ""}${FORMAT_LABEL[r.format]} · ${r.approx ? t("edit.size.approx", { size }) : size}`;
    const old = opened.fileSize;
    if (old > 0 && r.bytes > old) {
      larger = true;
      delta = t("edit.size.larger", { pct: Math.round((r.bytes / old - 1) * 100) });
    } else if (old > 0 && tab === "compress") {
      delta = t("edit.size.saved", { pct: Math.round((1 - r.bytes / old) * 100) });
    }
  }

  return (
    <div className={`edit-size${larger ? " is-larger" : ""}`}>
      <span className="edit-size-src">{src}</span>
      <span className="edit-size-arrow" aria-hidden="true">→</span>
      <span className="edit-size-out">{out}</span>
      {delta !== null && <span className="edit-size-delta">{delta}</span>}
    </div>
  );
}
