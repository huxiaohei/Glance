import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import type { ImageEntry } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { markSwitchPainted } from "../../lib/perfMarks";
import type { Size } from "../../lib/viewport";
import { useCatalog } from "../../stores/catalog";
import { useThumbs } from "../../stores/thumbs";
import type { Loaded, Preloader } from "./preloader";
import { useStageViewport, type StageApi } from "./useStageViewport";

export type { StageApi };

/** 当前画面的缩放接口，供单张视图的命令调用；没有画面时为 null。 */
export const useStageApi: UseBoundStore<StoreApi<{ api: StageApi | null }>> = create<{ api: StageApi | null }>(() => ({
  api: null,
}));

/** 文件版本：修改时间与大小。缩略图的 v 用同样的写法。 */
const versionOf = (entry: ImageEntry) => `${entry.mtimeMs}-${entry.size}`;

/** 原图地址：带文件版本，内容变化时地址随之变化。 */
export function imageUrl(entry: ImageEntry): string {
  return glanceUrl(`image/${entry.id}?v=${versionOf(entry)}`);
}

/** 上一次放进画面的原图。 */
interface ShownFull { id: FileId; url: string; img: HTMLImageElement; size: Size | null }

/** 预加载器里 (id, url) 这一项的状态；就绪或失败时重新渲染。 */
function useLoaded(preloader: Preloader, id: FileId, url: string | null): Loaded | null {
  const subscribe = useCallback(
    (cb: () => void) => preloader.subscribe((changed) => {
      if (changed === id) cb();
    }),
    [preloader, id],
  );
  return useSyncExternalStore(subscribe, () => (url ? preloader.get(id, url) : null));
}

/**
 * 单张视图的画面。显示规则：当前图已解码 → 直接把预加载器解码好的元素放进画面；否则先铺它已就绪、
 * 且与条目当前版本一致的缩略图（按原图像素尺寸、与原图同一变换，换上原图时不跳），没有这样的缩略图或
 * 尺寸未知时画面留空；解码失败 → “无法读取”占位。换了一张图时旧图不会留在画面上；同一张图被改写时，
 * 新版本解码完成（或失败）前保留旧图，按旧尺寸与旧视口显示。左下角显示当前比例；children 叠在画面之上。
 */
export default function Stage({ id, preloader, children }: { id: FileId; preloader: Preloader; children?: ReactNode }) {
  const entry = useCatalog((s) => s.entries.get(id));
  const thumb = useThumbs((s) => s.ready.get(id));
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [under, setUnder] = useState<HTMLImageElement | null>(null);

  const w = entry?.width;
  const h = entry?.height;
  const size = useMemo<Size | null>(() => (w && h ? { w, h } : null), [w, h]);
  const url = entry ? imageUrl(entry) : null;
  const loaded = useLoaded(preloader, id, url);
  const full = loaded?.state === "ready" ? loaded.img : null;
  const failed = loaded?.state === "error";

  // 同一张图改写后（地址变了）新版本还没解码好：继续显示上一次的原图，连同它的尺寸与视口
  const lastFull = useRef<ShownFull | null>(null);
  const prev = lastFull.current;
  const hold = !full && !failed && prev && prev.id === id && prev.url !== url ? prev : null;
  const display = full ?? hold?.img ?? null;

  // 垫底的缩略图要按原图尺寸铺放：尺寸未知时不垫；缩略图须是当前版本的，旧内容不按新尺寸拉伸
  const thumbOk = !!thumb && !!entry && thumb.v === versionOf(entry);
  const thumbUrl = !display && !failed && size && thumbOk ? glanceUrl(`thumb/${id}/${thumb.tier}?v=${thumb.v}`) : null;
  const shown = display ?? (thumbUrl ? under : null);

  // 只记画面上的原图：画面上没有原图（换了图未命中、占位）时清掉，回到同一 id 时不会翻出旧元素
  useLayoutEffect(() => {
    if (full && url) lastFull.current = { id, url, img: full, size };
    else if (!hold) lastFull.current = null;
  }, [full, hold, id, url, size]);

  // 解码好的元素由预加载器持有，直接放进画面（不经过 React 的子节点），换图只是一次替换
  useLayoutEffect(() => {
    if (!slot) return;
    if (!display) {
      slot.replaceChildren();
      return;
    }
    display.className = "stage-img";
    display.alt = "";
    display.draggable = false;
    slot.replaceChildren(display);
  }, [slot, display]);

  const { api, percent } = useStageViewport({
    box,
    img: shown,
    size: hold ? hold.size : size,
    imageKey: hold ? hold.url : (url ?? ""),
  });

  useEffect(() => {
    useStageApi.setState({ api });
    return () => {
      if (useStageApi.getState().api === api) useStageApi.setState({ api: null });
    };
  }, [api]);

  // 新内容（原图、缩略图或占位）进入文档后的下一帧记录切图耗时
  const painted = shown ?? (failed ? url : null);
  useLayoutEffect(() => {
    if (painted === null) return;
    const frame = requestAnimationFrame(() => markSwitchPainted());
    return () => cancelAnimationFrame(frame);
  }, [painted]);

  return (
    <div className="stage" ref={setBox}>
      <div className="stage-layer" ref={setSlot} />
      {thumbUrl && (
        <img key={thumbUrl} ref={setUnder} className="stage-img stage-underlay" src={thumbUrl} alt="" draggable={false} />
      )}
      {failed && <div className="stage-unreadable">{t("grid.unreadable")}</div>}
      {percent > 0 && shown && <div className="stage-percent">{percent}%</div>}
      {children}
    </div>
  );
}
