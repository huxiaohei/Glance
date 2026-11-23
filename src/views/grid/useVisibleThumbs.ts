import { useEffect } from "react";
import { thumbsWant } from "../../ipc/api";
import type { Tier } from "../../ipc/types";
import { visibleIds, type GridLayout } from "../../lib/gridLayout";
import { useThumbs } from "../../stores/thumbs";

/** 可见区（上下各扩一屏）内的缩略图，去抖 50ms 后向后端登记需求。 */
export function useVisibleThumbs(layout: GridLayout, scrollTop: number, viewHeight: number, tier: Tier): void {
  useEffect(() => {
    if (viewHeight <= 0) return;
    const ids = visibleIds(layout, scrollTop, viewHeight, viewHeight);
    let stale = false;
    const timer = setTimeout(() => {
      thumbsWant("grid", ids, tier)
        .then((ready) => {
          if (!stale && ready.length > 0) useThumbs.getState().markReady(ready, tier);
        })
        .catch(() => {});
    }, 50);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [layout, scrollTop, viewHeight, tier]);
}
