import { useState } from "react";
import { useEditUi } from "../../stores/editUi";
import "./edit.css";

/**
 * 编辑结果的画面：放在 Stage 里、原图图层之前，由单张视图的视口写上与原图相同的宽高与 transform
 * （onEl 交出这个元素），所以代理结果也按原图显示尺寸拉伸，缩放平移照常。
 * 新结果加载完成前继续显示上一张；有结果显示时样式表把原图藏起来（透明区域不透出原图）。
 * “按住查看原图”时整层隐藏。
 */
export default function EditLayer({ onEl }: { onEl(el: HTMLDivElement | null): void }) {
  const resultUrl = useEditUi((s) => s.resultUrl);
  const showOriginal = useEditUi((s) => s.showOriginal);
  // 已加载完成、正在显示的结果地址
  const [current, setCurrent] = useState<string | null>(null);
  const pending = resultUrl !== null && resultUrl !== current ? resultUrl : null;
  const shown = current !== null && !showOriginal;

  return (
    <div className={`edit-layer${shown ? " shown" : ""}`} ref={onEl}>
      {current !== null && <img key={current} className="edit-img edit-current" src={current} alt="" draggable={false} />}
      {pending !== null && (
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
