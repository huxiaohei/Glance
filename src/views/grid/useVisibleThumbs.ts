import { useEffect } from "react";
import { thumbsWant } from "../../ipc/api";
import type { Tier } from "../../ipc/types";
import { wantedIds, type GridLayout } from "../../lib/gridLayout";
import { useThumbs } from "../../stores/thumbs";

/** 可见区（上下各扩一屏）内的缩略图，去抖 50ms 后向后端登记需求。 */
export function useVisibleThumbs(layout: GridLayout, scrollTop: number, viewHeight: number, tier: Tier): void {
  useEffect(() => {
    if (viewHeight <= 0) return;
    const ids = wantedIds(layout, scrollTop, viewHeight, viewHeight);
    const timer = setTimeout(() => {
      // 已确认损坏的文件不再请求，免得每次都重新解码
      const { broken } = useThumbs.getState();
      thumbsWant("grid", ids.filter((id) => !broken.has(id)), tier)
        .then((ready) => {
          if (ready.length > 0) useThumbs.getState().markReady(ready, tier);
        })
        .catch(() => {});
    }, 50);
    return () => {
      clearTimeout(timer);
    };
  }, [layout, scrollTop, viewHeight, tier]);
}
