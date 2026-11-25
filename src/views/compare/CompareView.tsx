import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { basketCheck } from "../../ipc/api";
import type { FileId } from "../../ipc/types";
import { majoritySize, type BasketItem } from "../../lib/basket";
import { cellScale } from "../../lib/compareViewport";
import type { Size } from "../../lib/viewport";
import { basketItem, useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi, viewportOf } from "../../stores/compareUi";
import { useSettings } from "../../stores/settings";
import { showToast } from "../../stores/toast";
import CompareCell from "./CompareCell";
import CompareTopBar from "./CompareTopBar";
import { useCompareImages } from "./useCompareImages";
import "./compare.css";

const NO_BOX: Size = { w: 0, h: 0 };

/** 图片区的尺寸（所有格相同）：量第一格的图片区。格宽只取决于滚动区宽度（含滚动条出没）与列数，
 *  所以观察滚动区；列数、格数变化时重量。每次现查第一格，免得量到已移出的格子。 */
function useCellBox(scroller: HTMLElement | null, columns: number, count: number): Size {
  const [box, setBox] = useState<Size>(NO_BOX);
  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => {
      const first = scroller.querySelector<HTMLElement>(".compare-img");
      const w = first?.clientWidth ?? 0;
      const h = first?.clientHeight ?? 0;
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller, columns, count]);
  return box;
}

/** 进入时核对篮内文件是否还在：缺失的标记出来并提示，提示条可一键全部移出。 */
function checkOnEnter(isLive: () => boolean): void {
  const ids = [...useBasket.getState().order];
  if (ids.length === 0) return;
  basketCheck(ids)
    .then((results) => {
      useBasket.getState().applyCheck(results, ids);
      if (!isLive()) return;
      const { order, missing } = useBasket.getState();
      const gone = order.filter((id) => missing.has(id));
      if (gone.length === 0) return;
      showToast({
        text: t("compare.missingToast", { n: gone.length }),
        actions: [{ label: t("compare.removeAll"), run: () => void useBasket.getState().remove([...useBasket.getState().missing]) }],
      });
    })
    .catch(() => {});
}

/**
 * 对比视图：对比篮里的图按固定列数排成网格，每格同样大小（图片区 2:3 竖版），下方一行说明。
 * 挂载即一次进入（按设置决定同步、视口回到适应、核对缺失）；hidden 时（对比篮来源的单张视图盖在上面）
 * 只隐藏不卸载，返回时滚动位置与视口原样保留。不做虚拟化（V0.2-B 要拖动排序）。
 */
export default function CompareView({ hidden = false }: { hidden?: boolean }) {
  const order = useBasket((s) => s.order);
  const missing = useBasket((s) => s.missing);
  const basketItems = useBasket((s) => s.items);
  const entries = useCatalog((s) => s.entries);
  const columns = useSettings((s) => s.settings.compareColumns);
  const bg = useSettings((s) => s.settings.compareBackground);
  const viewport = useCompareUi((s) => s.viewport);
  const perCell = useCompareUi((s) => s.perCell);
  const focus = useCompareUi((s) => s.focus);
  const captions = useCompareUi((s) => s.captions);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const box = useCellBox(scroller, columns, order.length);

  // 挂载 = 一次新的进入（从单张返回时本视图一直挂着，不会走到这里）
  useLayoutEffect(() => {
    const { compareSyncOnEnter } = useSettings.getState().settings;
    useCompareUi.getState().enter(compareSyncOnEnter, useBasket.getState().order[0] ?? null);
  }, []);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    checkOnEnter(() => live.current);
    return () => {
      live.current = false;
    };
  }, []);

  // 条目：在当前目录里的用 catalog 的实时条目，否则用篮内快照。basketItem 读的正是 entries 与
  // basketItems 这两份，二者变化（尺寸补全、改写、核对结果）时重算
  const items = useMemo(
    () => new Map<FileId, BasketItem | undefined>(order.map((id) => [id, basketItem(id)])),
    [order, basketItems, entries],
  );
  const present = useMemo(() => order.filter((id) => !missing.has(id)), [order, missing]);
  const majority = useMemo(() => majoritySize(present.map((id) => items.get(id) ?? {})), [present, items]);

  // 每格的显示长边（设备像素）：决定是否换原图
  const longSides = useMemo(() => {
    const dpr = window.devicePixelRatio || 1;
    const out = new Map<FileId, number>();
    if (box.w <= 0 || box.h <= 0) return out;
    for (const id of present) {
      const it = items.get(id);
      const img = it?.width && it.height ? { w: it.width, h: it.height } : null;
      const long = img
        ? cellScale(viewportOf({ viewport, perCell }, id), img, box) * Math.max(img.w, img.h) * dpr
        : Math.max(box.w, box.h) * dpr;
      out.set(id, long);
    }
    return out;
  }, [present, items, box, viewport, perCell]);
  const full = useCompareImages(scroller, present, longSides);

  // 隐藏时焦点若还留在顶栏里（例如下拉框），按键会被当成在输入框里：移走焦点（与网格相同）
  const viewRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!hidden) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && viewRef.current?.contains(active)) active.blur();
  }, [hidden]);

  return (
    <div
      ref={viewRef}
      className={hidden ? "compare-view compare-hidden" : "compare-view"}
      data-bg={bg}
      inert={hidden}
    >
      <CompareTopBar count={order.length} />
      <div ref={setScroller} className="compare-scroller">
        <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {order.map((id) => {
            const it = items.get(id);
            const odd =
              majority !== null && it?.width !== undefined && it.height !== undefined
              && (it.width !== majority.w || it.height !== majority.h);
            return (
              <CompareCell
                key={id}
                id={id}
                item={it}
                missing={missing.has(id)}
                odd={odd}
                captions={captions}
                focused={focus === id}
                box={box}
                vp={viewportOf({ viewport, perCell }, id)}
                full={full.has(id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
