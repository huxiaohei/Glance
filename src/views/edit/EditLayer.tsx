import { useState } from "react";
import { useEditUi } from "../../stores/editUi";
import "./edit.css";

/**
 * 编辑结果的画面：放在 Stage 里、原图图层之前，由单张视图的视口写上与原图相同的宽高与 transform
 * （onEl 交出这个元素），所以代理结果也按原图显示尺寸拉伸，缩放平移照常。
 * 新结果加载完成前继续显示上一张；有结果显示时样式表把原图藏起来（透明区域不透出原图）。
 * “按住查看原图”时整层隐藏。裁剪页不显示结果（画面由 CropStage 盖住），也不藏原图；
 * 进出裁剪页时 store 清掉结果，这里随之丢掉已显示的那张，新结果加载完成前露出原图。
 * 去背景页给图层加 is-checker：结果图背后衬棋盘格，透明区域露出它。
 */
export default function EditLayer({ onEl }: { onEl(el: HTMLDivElement | null): void }) {
  const resultUrl = useEditUi((s) => s.resultUrl);
  const showOriginal = useEditUi((s) => s.showOriginal);
  const cropping = useEditUi((s) => s.tab === "crop");
  const checker = useEditUi((s) => s.tab === "removeBg");
  // 已加载完成、正在显示的结果地址
  const [current, setCurrent] = useState<string | null>(null);
  // 结果被清掉（进出裁剪页）：之前显示的那张也不再保留
  if (resultUrl === null && current !== null) setCurrent(null);
  const pending = resultUrl !== null && resultUrl !== current ? resultUrl : null;
  const shown = current !== null && !showOriginal && !cropping;

  return (
    <div className={`edit-layer${shown ? " shown" : ""}${checker ? " is-checker" : ""}`} ref={onEl}>
      {!cropping && current !== null && <img key={current} className="edit-img edit-current" src={current} alt="" draggable={false} />}
      {!cropping && pending !== null && (
        <img
          key={pending}
          className="edit-img edit-pending"
          src={pending}
          alt=""
          draggable={false}
          onLoad={() => setCurrent(pending)}
        />
      )}
    </div>
  );
}
