import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { t } from "../../i18n";
import { browseDir, thumbsWant } from "../../ipc/api";
import type { FileId } from "../../ipc/types";
import type { BasketItem } from "../../lib/basket";
import { dirTree } from "../../lib/deriveList";
import { glanceUrl } from "../../lib/glanceUrl";
import { panelIds, panelKey, panelOptions } from "../../lib/panelSource";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useCompareUi } from "../../stores/compareUi";
import { useListView } from "../../stores/listView";
import { useThumbs } from "../../stores/thumbs";
import { showToast } from "../../stores/toast";
import { currentPanelIds, PANEL_COLUMNS, togglePanelItem } from "./compareActions";
import NoCodecMark from "../common/NoCodecMark";

const TIER = 320;
const COLUMNS = PANEL_COLUMNS;
/** 格子边长与间距（px）：面板宽 280，左右各留 12 */
const CELL = 80;
const GAP = 8;
const ROW = CELL + GAP;
/** 可视行之外各多渲染几行 */
const OVERSCAN = 2;

/** 按下不拿焦点：焦点留在页面上，命令表照常响应。 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

// 只认最近一次扫描的结果：连续选两次其他文件夹、或扫描未回来时改选了别的来源，先发的晚到也不覆盖
let scanSeq = 0;

/** 扫描其他文件夹：成功则把它记为“其他文件夹”并设为来源；失败提示，来源不变。 */
function scanOther(path: string): void {
  const seq = ++scanSeq;
  browseDir(path)
    .then((r) => {
      if (seq !== scanSeq) return;
      const items: BasketItem[] = r.entries.map((e) => ({
        id: e.id, name: e.name, dirName: r.name, size: e.size, mtimeMs: e.mtimeMs,
      }));
      const ui = useCompareUi.getState();
      ui.setOtherDir({ path, name: r.name, count: items.length });
      ui.setPanelSource({ kind: "other", name: r.name, items });
    })
    .catch(() => {
      if (seq === scanSeq) showToast({ text: t("compare.panel.browseFailed") });
    });
}

async function pickOther(): Promise<void> {
  const picked = await openDialog({ directory: true, multiple: false });
  if (typeof picked === "string") scanOther(picked);
}

function onSourceChange(key: string): void {
  const ui = useCompareUi.getState();
  // 改选当前文件夹或子目录：作废还没回来的扫描
  if (key === "root" || key.startsWith("dir:")) scanSeq++;
  if (key === "pick") void pickOther().catch(() => {});
  else if (key === "other") { if (ui.otherDir) scanOther(ui.otherDir.path); }
  else if (key === "root") ui.setPanelSource({ kind: "root" });
  else if (key.startsWith("dir:")) ui.setPanelSource({ kind: "dir", dir: key.slice(4) });
}

/** 一格：方形缩略图（完整显示），已在篮中的右上角琥珀点；悬停显示文件名；键盘焦点在此时带焦点框。 */
const PanelCell = memo(function PanelCell(
  { id, name, top, left, focused }: { id: FileId; name: string; top: number; left: number; focused: boolean },
) {
  const ready = useThumbs((s) => s.ready.get(id));
  const broken = useThumbs((s) => s.broken.has(id));
  const noCodec = useThumbs((s) => s.noCodec.has(id));
  const inBasket = useBasket((s) => s.items.has(id));
  const src = ready ? glanceUrl(`thumb/${id}/${ready.tier}?v=${ready.v}`) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <button
      type="button"
      className={focused ? "compare-panel-item is-focus" : "compare-panel-item"}
      data-id={id}
      title={name}
      aria-pressed={inBasket}
      style={{ top, left, width: CELL, height: CELL }}
      onMouseDown={keepFocus}
    >
      {noCodec && <NoCodecMark className="compare-panel-nocodec" />}
      {!broken && !noCodec && src && failedSrc !== src && (
        <img src={src} alt="" draggable={false} onError={() => setFailedSrc(src)} />
      )}
      {inBasket && <span className="compare-panel-badge" role="img" aria-label={t("basket.inBasket")} />}
    </button>
  );
});

/**
 * 对比视图右侧的添加面板：来源下拉（当前文件夹、各子目录、其他文件夹），3 列缩略图（固定行高虚拟化），
 * 点击把该图加入 / 移出对比篮。当前文件夹与子目录照搬网格的排序与包含子目录，但不动网格的筛选。
 */
export default function ComparePanel() {
  const root = useCatalog((s) => s.root);
  const listVersion = useCatalog((s) => s.listVersion);
  const sort = useListView((s) => s.sort);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const source = useCompareUi((s) => s.panelSource);
  const otherDir = useCompareUi((s) => s.otherDir);
  const panelFocus = useCompareUi((s) => s.panelFocus);
  const focusInPanel = useCompareUi((s) => s.focusArea === "panel");
  const generation = root?.generation;

  // 条目集合（listVersion）变了才重算；尺寸补全不影响面板
  const { ids, options } = useMemo(() => {
    const entries = useCatalog.getState().entries;
    const ids = currentPanelIds();
    const other = otherDir && { name: otherDir.name, count: otherDir.count };
    let options;
    if (root === null) {
      options = panelOptions([], 0, other).filter((o) => o.key !== "root");
    } else {
      // 包含子目录关闭时子目录只列本层，张数也只数本层
      const tree = dirTree(entries.values()).map((n) => (includeSubdirs ? n : { ...n, total: n.count }));
      const rootCount = panelIds(entries, sort, includeSubdirs, { kind: "root" }).length;
      options = panelOptions(tree, rootCount, other);
    }
    return { ids, options };
  }, [root, listVersion, sort, includeSubdirs, source, otherDir]);

  // 其他文件夹的条目不在 catalog 里：点击时用扫描时的快照
  const byId = useMemo(
    () => new Map<FileId, BasketItem>(source.kind === "other" ? source.items.map((it) => [it.id, it]) : []),
    [source],
  );
  const nameOf = (id: FileId) => byId.get(id)?.name ?? useCatalog.getState().entries.get(id)?.name ?? "";

  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current!;
    const read = () => setHeight(el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 换来源回到顶部
  useLayoutEffect(() => {
    const el = ref.current!;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [source]);

  // 面板焦点（键盘移动、Tab 打开时）滚进可视区：目标行可能还没渲染，按行号直接设 scrollTop。
  // 只跟着焦点变，不跟着列表变（列表刷新时不把手动滚开的位置拉回来）
  useLayoutEffect(() => {
    const i = panelFocus === null ? -1 : ids.indexOf(panelFocus);
    if (i < 0) return;
    const el = ref.current!;
    const top = Math.floor(i / COLUMNS) * ROW;
    const h = el.clientHeight;
    let next = el.scrollTop;
    if (top < next) next = top;
    else if (top + CELL > next + h) next = top + CELL - h;
    if (next === el.scrollTop) return;
    el.scrollTop = next;
    setScrollTop(next);
  }, [panelFocus]);

  const rows = Math.ceil(ids.length / COLUMNS);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const shown = useMemo(() => ids.slice(first * COLUMNS, last * COLUMNS), [ids, first, last]);

  // 去抖 50ms 后登记可视格子的需求，跳过损坏的与已有当前版本（档位不低于 TIER）的；刷新后重新登记
  useEffect(() => {
    const timer = setTimeout(() => {
      const { broken, noCodec, ready } = useThumbs.getState();
      const entries = useCatalog.getState().entries;
      const have = (id: FileId) => {
        const r = ready.get(id);
        const e = byId.get(id) ?? entries.get(id);
        return !!r && !!e && r.tier >= TIER && r.v === `${e.mtimeMs}-${e.size}`;
      };
      thumbsWant("comparePanel", shown.filter((id) => !broken.has(id) && !noCodec.has(id) && !have(id)), TIER)
        .then((got) => {
          if (got.length > 0) useThumbs.getState().markReady(got, TIER);
        })
        .catch(() => {});
    }, 50);
    return () => clearTimeout(timer);
  }, [shown, byId, generation]);

  // 收起面板或离开对比视图时撤销需求
  useEffect(
    () => () => {
      thumbsWant("comparePanel", [], TIER).catch(() => {});
    },
    [],
  );

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".compare-panel-item");
    if (!el) return;
    const id = Number(el.dataset.id);
    const ui = useCompareUi.getState();
    ui.setPanelFocus(id);
    ui.setFocusArea("panel");
    togglePanelItem(id);
  };

  const key = panelKey(source);
  const value = options.some((o) => o.key === key) ? key : "";

  return (
    <aside className="compare-panel">
      <div className="compare-panel-head">
        <div className="compare-panel-title">{t("compare.panel.title")}</div>
        <select
          aria-label={t("compare.panel.source")}
          value={value}
          onChange={(e) => {
            onSourceChange(e.target.value);
            // 下拉框留着焦点时按键都当作在输入框里，Esc 等命令不响应
            e.currentTarget.blur();
          }}
        >
          {value === "" && <option value="" hidden />}
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {"  ".repeat(o.depth)}
              {t("compare.panel.option", { label: o.key === "root" ? t("compare.panel.current") : o.label, n: o.count })}
            </option>
          ))}
          {options.length > 0 && <option disabled>──────</option>}
          <option value="pick">{t("compare.panel.pick")}</option>
        </select>
      </div>
      <div
        ref={ref}
        className="compare-panel-scroller"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onClick={onClick}
      >
        <div className="compare-panel-content" style={{ height: Math.max(0, rows * ROW - GAP) }}>
          {shown.map((id, i) => {
            const n = first * COLUMNS + i;
            return (
              <PanelCell
                key={id}
                id={id}
                name={nameOf(id)}
                top={Math.floor(n / COLUMNS) * ROW}
                left={(n % COLUMNS) * ROW}
                focused={focusInPanel && panelFocus === id}
              />
            );
          })}
        </div>
      </div>
      <div className="compare-panel-hint">{t("compare.panel.hint")}</div>
    </aside>
  );
}
