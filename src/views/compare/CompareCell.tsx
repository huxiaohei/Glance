import { memo, type CSSProperties } from "react";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { cellTransform, type CompareViewport } from "../../lib/compareViewport";
import { displayWidth, middleEllipsis } from "../../lib/middleEllipsis";
import type { Size } from "../../lib/viewport";
import { useThumbs } from "../../stores/thumbs";
import { cellSources } from "./useCompareImages";

interface Props {
  id: FileId;
  item: BasketItem | undefined;
  missing: boolean;
  /** 尺寸与篮中多数不同 */
  odd: boolean;
  captions: boolean;
  focused: boolean;
  /** 图片区的尺寸（所有格相同）；未量出时为 0 */
  box: Size;
  vp: CompareViewport;
  /** 用原图（在视口里且显示尺寸够大） */
  full: boolean;
}

/** 说明文字 12px：窄字符约 6.5px，按窄字符单位估算文件名的预算，给尺寸与分隔符留出位置。 */
function nameBudget(boxW: number, sizeText: string): number {
  const total = Math.floor(boxW / 6.5);
  return Math.max(8, total - (sizeText ? displayWidth(sizeText) + 3 : 0));
}

/** 已知尺寸且量出了格子：按视口换算的 transform（宽高为图片像素，transform-origin 0 0）；否则整张塞进格子。 */
function imgStyle(vp: CompareViewport, img: Size | null, box: Size): CSSProperties | undefined {
  if (!img || box.w <= 0 || box.h <= 0) return undefined;
  const v = cellTransform(vp, img, box);
  return { width: img.w, height: img.h, transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale})` };
}

/**
 * 对比视图的一格：图片区（缩略图垫底，原图到达后盖在上面）与下方一行说明“文件名 · 宽×高”。
 * 缺失的格显示“文件已不在”。移出按钮与交互由任务 8 加上。
 */
function CompareCell({ id, item, missing, odd, captions, focused, box, vp, full }: Props) {
  const ready = useThumbs((s) => s.ready.get(id));
  const w = item?.width;
  const h = item?.height;
  const img = w && h ? { w, h } : null;
  const style = imgStyle(vp, img, box);
  const { thumb, original } = item && !missing ? cellSources(item, ready, full) : { thumb: null, original: null };
  const imgClass = style ? "compare-pic" : "compare-pic compare-pic-fit";
  const sizeText = img ? `${img.w}×${img.h}` : "";
  const name = item?.name ?? "";

  return (
    <div className={`compare-cell${focused ? " is-focus" : ""}${missing ? " is-missing" : ""}`} data-id={id}>
      <div className="compare-img">
        {missing ? (
          <div className="compare-missing">{t("compare.missing")}</div>
        ) : (
          <>
            {thumb && <img className={imgClass} src={thumb} style={style} alt="" draggable={false} />}
            {original && <img className={imgClass} src={original} style={style} alt="" draggable={false} />}
          </>
        )}
      </div>
      {captions && (
        <div className="compare-caption" title={sizeText ? `${name} · ${sizeText}` : name}>
          <span className="compare-name">{middleEllipsis(name, nameBudget(box.w, sizeText))}</span>
          {sizeText && (
            <>
              {" · "}
              <span className={odd ? "compare-size is-odd" : "compare-size"}>{sizeText}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(CompareCell);
