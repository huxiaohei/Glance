import { useSingleEntry, useSingleList } from "../../app/singleSource";
import type { FileId } from "../../ipc/types";
import { hasSize } from "../../lib/deriveList";
import { formatBytes } from "../../lib/formatBytes";
import { editHints, singleHints } from "../../lib/keyHints";
import { useBasket } from "../../stores/basket";
import { useEditUi } from "../../stores/editUi";
import { useSettings } from "../../stores/settings";
import KeyHints from "../common/KeyHints";

/** 格式标签：扩展名大写，jpeg 显示为 JPG；没有扩展名返回 null。 */
function formatLabel(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return null;
  const ext = name.slice(i + 1).toUpperCase();
  return ext === "JPEG" ? "JPG" : ext;
}

/** 单张视图底部常驻信息条：文件名、宽 × 高、大小、格式，快捷键提示，右侧 序号 / 总数。 */
export default function InfoBar({ id }: { id: FileId }) {
  const entry = useSingleEntry(id);
  const list = useSingleList();
  const index = list.ids.indexOf(id);
  const format = entry ? formatLabel(entry.name) : null;
  const showHints = useSettings((s) => s.settings.showKeyHints);
  const basket = useBasket((s) => s.order.length);
  const editing = useEditUi((s) => s.status !== "idle");
  const inBasket = useBasket((s) => s.order.includes(id));

  return (
    <div className="single-infobar">
      {entry && (
        <>
          <span className="info-name" title={entry.name}>
            {entry.name}
          </span>
          {hasSize(entry) && (
            <span className="info-dims">{`${entry.width} × ${entry.height}`}</span>
          )}
          <span className="info-size">{formatBytes(entry.size)}</span>
          {format && <span className="info-format">{format}</span>}
        </>
      )}
      {showHints && <KeyHints hints={editing ? editHints() : singleHints({ currentInBasket: inBasket, basket })} />}
      {index >= 0 && <span className="info-index">{`${index + 1} / ${list.ids.length}`}</span>}
    </div>
  );
}
