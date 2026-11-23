import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { t } from "../../i18n";
import { thumbsWant } from "../../ipc/api";
import type { FileId } from "../../ipc/types";
import type { ImageList } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { markSwitchStart } from "../../lib/perfMarks";
import { layoutStrip, scrollToShow, STRIP_DIVIDER, STRIP_GAP, STRIP_ITEM, stripVisible } from "../../lib/stripLayout";
import { useCatalog } from "../../stores/catalog";
import { topView, useNav } from "../../stores/nav";
import { useThumbs } from "../../stores/thumbs";

const TIER = 320;

/** 一个方格：缩略图完整显示在方格内；未就绪显示占位，损坏显示标记。 */
const StripCell = memo(function StripCell({ id, left, current }: { id: FileId; left: number; current: boolean }) {
  const ready = useThumbs((s) => s.ready.get(id));
  const broken = useThumbs((s) => s.broken.has(id));
  const src = ready ? glanceUrl(`thumb/${id}/${ready.tier}?v=${ready.v}`) : null;
  // 文件被改动或删除时协议返回 404：改显占位
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className={`strip-item${current ? " strip-current" : ""}`} data-id={id} style={{ left }}>
      {broken ? (
        <div className="strip-broken" title={t("grid.unreadable")} />
      ) : src && failedSrc !== src ? (
        <img className="strip-img" src={src} alt="" draggable={false} onError={() => setFailedSrc(src)} />
      ) : (
        <div className="strip-placeholder" />
      )}
    </div>
  );
});

/** 点击某项跳到那张图（计入切图耗时）。所有方格共用这一个处理函数。 */
function onStripClick(e: MouseEvent<HTMLDivElement>): void {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".strip-item");
  if (!item) return;
  const id = Number(item.dataset.id);
  // 点当前项不算切图：不会有随后的绘制，留下的开始标记会与之后无关的绘制配对
  const top = topView();
  if (top.kind === "single" && top.id === id) return;
  markSwitchStart();
  useNav.getState().setCurrent(id);
}

/**
 * 单张视图底部的缩略图条：横向虚拟滚动，只渲染可见项（左右各扩一屏）。
 * 当前项高亮，并在当前图或布局变化时滚到可见；用户自己滚动条时不拉回。
 */
export default function Filmstrip({ list, current }: { list: ImageList; current: FileId }) {
  const layout = useMemo(() => layoutStrip(list), [list]);
  const indexOf = useMemo(() => new Map(layout.items.map((x, i) => [x.id, i])), [layout]);
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const generation = useCatalog((s) => s.root?.generation);

  // 视口宽度
  useLayoutEffect(() => {
    const el = ref.current!;
    const read = () => setView(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 滚动位置按帧同步到状态；滚轮横向滚动条（纵向量也当横向），不让画面缩放
  useEffect(() => {
    const el = ref.current!;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollLeft(el.scrollLeft);
      });
    };
    const onWheel = (e: WheelEvent) => {
      const d = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (d === 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollLeft += e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * el.clientWidth : d;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // 当前项保持可见：只在当前图换了、当前项的位置被布局挪动了、或第一次量到视口宽度时调整；
  // 视口宽度变了（如详细信息面板展开）时，只在当前项原先完整可见时调整。
  // 列表刷新（内容未挪动当前项）、用户已把它滚走时的缩放、用户自己滚动都不动条。不用平滑滚动，免得跟不上连按
  const index = indexOf.get(current) ?? -1;
  const currentLeft = index < 0 ? null : layout.items[index].left;
  const shownFor = useRef<{ id: FileId; left: number; view: number } | null>(null);
  useLayoutEffect(() => {
    if (currentLeft === null || view <= 0) return;
    const el = ref.current!;
    const last = shownFor.current;
    shownFor.current = { id: current, left: currentLeft, view };
    if (last && last.id === current && last.left === currentLeft) {
      if (last.view === view) return;
      const wasVisible = currentLeft >= el.scrollLeft && currentLeft + STRIP_ITEM <= el.scrollLeft + last.view;
      if (!wasVisible) return;
    }
    const next = Math.round(scrollToShow(layout, index, el.scrollLeft, view));
    if (next !== el.scrollLeft) el.scrollLeft = next;
    setScrollLeft(next);
  }, [current, currentLeft, index, layout, view]);

  // 可见项（左右各扩一屏）：既是渲染的项，也是登记需求的项
  const shown = useMemo(() => (view > 0 ? stripVisible(layout, scrollLeft, view, view) : []), [layout, scrollLeft, view]);

  // 去抖 50ms 后登记需求，跳过已损坏的、以及已有当前版本且档位不低于 TIER 的缩略图的
  // （网格常已备好 640）；刷新（generation 变化）后重新登记
  useEffect(() => {
    if (view <= 0) return;
    const timer = setTimeout(() => {
      const { broken, ready } = useThumbs.getState();
      const { entries } = useCatalog.getState();
      const have = (id: FileId) => {
        const r = ready.get(id);
        const e = entries.get(id);
        return !!r && !!e && r.tier >= TIER && r.v === `${e.mtimeMs}-${e.size}`;
      };
      thumbsWant("strip", shown.filter((id) => !broken.has(id) && !have(id)), TIER)
        .then((ready) => {
          if (ready.length > 0) useThumbs.getState().markReady(ready, TIER);
        })
        .catch(() => {});
    }, 50);
    return () => clearTimeout(timer);
  }, [shown, view, generation]);

  // 离开单张视图时撤销需求
  useEffect(
    () => () => {
      thumbsWant("strip", [], TIER).catch(() => {});
    },
    [],
  );

  return (
    <div className="single-strip">
      <div ref={ref} className="strip-scroller" onClick={onStripClick}>
        <div className="strip-content" style={{ width: layout.width }}>
          {shown.map((id) => {
            const { left, groupStart } = layout.items[indexOf.get(id)!];
            return (
              <Fragment key={id}>
                {/* 分组的起首项前画一条细线，居中于分组间的空隙 */}
                {groupStart && <div className="strip-divider" style={{ left: left - (STRIP_GAP + STRIP_DIVIDER + 1) / 2 }} />}
                <StripCell id={id} left={left} current={id === current} />
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

