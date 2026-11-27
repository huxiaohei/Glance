import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { thumbsWant } from "../../ipc/api";
import type { FileId, Tier } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { glanceUrl } from "../../lib/glanceUrl";
import { useThumbs, type ReadyThumb } from "../../stores/thumbs";
import { imageUrl, versionOf } from "../single/Stage";

/** 占位缩略图的档位；显示长边超过它才值得换原图。 */
export const COMPARE_TIER: Tier = 640;
/** 滞后：超过 640 × 1.1 才换原图，降到 640 × 0.9 以下才换回，缩放时不来回切。 */
const UP = COMPARE_TIER * 1.1;
const DOWN = COMPARE_TIER * 0.9;

/**
 * 哪些格用原图：在列表里、在视口里，且显示长边（设备像素）够大。prev 是上一次的结果，用于滞后。
 * 结果与 prev 内容相同时返回 prev 本身。
 */
export function nextFull(
  prev: ReadonlySet<FileId>,
  ids: readonly FileId[],
  visible: ReadonlySet<FileId>,
  longSides: ReadonlyMap<FileId, number>,
): ReadonlySet<FileId> {
  const out = new Set<FileId>();
  for (const id of ids) {
    if (!visible.has(id)) continue;
    const long = longSides.get(id) ?? 0;
    if (prev.has(id) ? long >= DOWN : long > UP) out.add(id);
  }
  if (out.size === prev.size && [...out].every((id) => prev.has(id))) return prev;
  return out;
}

/** 一格的两层图：缩略图（须与条目同版本，免得旧内容按新尺寸铺放）垫底，原图（要用时）叠在上面。 */
export function cellSources(
  item: Pick<BasketItem, "id" | "mtimeMs" | "size">,
  ready: ReadyThumb | undefined,
  full: boolean,
): { thumb: string | null; original: string | null } {
  const thumb = ready && ready.v === versionOf(item) ? glanceUrl(`thumb/${item.id}/${ready.tier}?v=${ready.v}`) : null;
  return { thumb, original: full ? imageUrl(item) : null };
}

/**
 * 对比视图的图片加载：所有 id 向后端登记 640 缩略图（消费者 "compare"，离开时撤销）；
 * 用 IntersectionObserver 看 container 里带 data-id 的格子是否在视口；返回应当用原图的 id 集合。
 * 滚出视口的格子不在集合里，调用方随即摘掉原图地址，内存只随同屏格子数增长。
 * longSides：每格在屏幕上的显示长边（设备像素，含缩放与设备像素比）。
 */
export function useCompareImages(
  container: HTMLElement | null,
  ids: readonly FileId[],
  longSides: ReadonlyMap<FileId, number>,
): ReadonlySet<FileId> {
  const [visible, setVisible] = useState<ReadonlySet<FileId>>(() => new Set());

  useEffect(() => {
    const { broken, noCodec } = useThumbs.getState();
    thumbsWant("compare", ids.filter((id) => !broken.has(id) && !noCodec.has(id)), COMPARE_TIER)
      .then((ready) => {
        if (ready.length > 0) useThumbs.getState().markReady(ready, COMPARE_TIER);
      })
      .catch(() => {});
  }, [ids]);

  useEffect(
    () => () => {
      thumbsWant("compare", [], COMPARE_TIER).catch(() => {});
    },
    [],
  );

  // 格子随 ids 变化增减：每次重新观察全部格子；观察开始时观察器会先报一次各格的当前状态
  const [io, setIo] = useState<IntersectionObserver | null>(null);
  useEffect(() => {
    if (!container || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) =>
        setVisible((prev) => {
          let next: Set<FileId> | null = null;
          for (const e of entries) {
            const id = Number((e.target as HTMLElement).dataset.id);
            if (e.isIntersecting === prev.has(id)) continue;
            next ??= new Set(prev);
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next ?? prev;
        }),
      { root: container },
    );
    setIo(obs);
    return () => {
      obs.disconnect();
      setIo(null);
    };
  }, [container]);

  useLayoutEffect(() => {
    if (!io || !container) return;
    for (const el of container.querySelectorAll("[data-id]")) io.observe(el);
    return () => io.disconnect();
  }, [io, container, ids]);

  const prevFull = useRef<ReadonlySet<FileId>>(new Set());
  const full = useMemo(() => nextFull(prevFull.current, ids, visible, longSides), [ids, visible, longSides]);
  useEffect(() => {
    prevFull.current = full;
  }, [full]);
  return full;
}
