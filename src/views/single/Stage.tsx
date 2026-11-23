import { useEffect, useMemo, useState, type ReactNode } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileId } from "../../ipc/types";
import { glanceUrl } from "../../lib/glanceUrl";
import type { Size } from "../../lib/viewport";
import { useCatalog } from "../../stores/catalog";
import { useStageViewport, type StageApi } from "./useStageViewport";

export type { StageApi };

/** 当前画面的缩放接口，供单张视图的命令调用；没有画面时为 null。 */
export const useStageApi: UseBoundStore<StoreApi<{ api: StageApi | null }>> = create<{ api: StageApi | null }>(() => ({
  api: null,
}));

/** 单张视图的画面：图片按视口缩放平移，左下角显示当前比例。children 叠在画面之上。 */
export default function Stage({ id, children }: { id: FileId; children?: ReactNode }) {
  const entry = useCatalog((s) => s.entries.get(id));
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  const w = entry?.width;
  const h = entry?.height;
  const size = useMemo<Size | null>(() => (w && h ? { w, h } : null), [w, h]);
  const version = entry ? `${entry.mtimeMs}-${entry.size}` : "";
  const imageKey = `${id}?v=${version}`;
  const { api, percent } = useStageViewport({ box, img, size, imageKey });

  useEffect(() => {
    useStageApi.setState({ api });
    return () => {
      if (useStageApi.getState().api === api) useStageApi.setState({ api: null });
    };
  }, [api]);

  return (
    <div className="stage" ref={setBox}>
      {entry && <img ref={setImg} className="stage-img" src={glanceUrl(`image/${imageKey}`)} alt="" draggable={false} />}
      {percent > 0 && <div className="stage-percent">{percent}%</div>}
      {children}
    </div>
  );
}
