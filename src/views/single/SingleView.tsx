import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSingleEntry, useSingleList } from "../../app/singleSource";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { resolveCurrent } from "../../lib/currentImage";
import { cancelSwitch } from "../../lib/perfMarks";
import { preloadPlan } from "../../lib/preloadPlan";
import { useBasket } from "../../stores/basket";
import { useCatalog } from "../../stores/catalog";
import { useNav } from "../../stores/nav";
import { useRename } from "../../stores/rename";
import { useSingleUi } from "../../stores/singleUi";
import DetailsPanel from "./DetailsPanel";
import Filmstrip from "./Filmstrip";
import Hint from "./Hint";
import InfoBar from "./InfoBar";
import TopBar from "./TopBar";
import { Preloader } from "./preloader";
import { useIdle } from "./useIdle";
import Stage, { imageUrl } from "./Stage";
import { go } from "./singleCommands";
import "./single.css";

/** 鼠标静止这么久后顶栏和缩略图条淡出。 */
const IDLE_MS = 2000;
const BARS = ".single-topbar, .single-strip";

/**
 * 焦点是否由键盘落在 selector 之内。鼠标点按钮（WebView2 会让按钮保持焦点）不算，否则一次点击就让工具栏
 * 再也不淡出。不支持 :focus-visible 的旧 WebKit 点按钮本来就不给焦点，按键盘焦点处理。
 */
function keyboardFocusIn(el: Element, selector: string): boolean {
  if (el.closest(selector) === null) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** 画面左右边缘的箭头区域：指针在区域内时显示箭头，点击等同左右键。 */
function ArrowZone({ side }: { side: "left" | "right" }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // 画面的手势监听挂在容器上（原生监听，早于 React 的事件委托）：在这里原生拦下，
  // 点箭头不开始拖拽，连点两下也不当作画面上的双击
  useEffect(() => {
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("pointerdown", stop);
    el.addEventListener("dblclick", stop);
    return () => {
      el.removeEventListener("pointerdown", stop);
      el.removeEventListener("dblclick", stop);
    };
  }, [el]);
  return (
    <div
      ref={setEl}
      className={`stage-arrow stage-arrow-${side}`}
      title={t(side === "left" ? "cmd.single.prev" : "cmd.single.next")}
      onClick={() => go(side === "left" ? "prev" : "next")}
    >
      <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
        <path d={side === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
      </svg>
    </div>
  );
}

/** 单张视图：显示栈顶 single 的那张图，列表与条目按来源取（当前目录或对比篮）。列表变化时修正当前图，
 *  列表空了弹栈（回到网格，或对比篮来源时回到对比）。前后各两张预解码。 */
export default function SingleView() {
  const id = useNav((s) => {
    const top = s.stack[s.stack.length - 1];
    return top.kind === "single" ? top.id : null;
  });
  const list = useSingleList();
  // 条目经 getSingleEntry 按来源取；这两份只用来在条目变化（尺寸补全、改写、快照更新）时重算预解码集合
  const entries = useCatalog((s) => s.entries);
  const basketItems = useBasket((s) => s.items);
  const infoOpen = useSingleUi((s) => s.infoOpen);
  const [preloader] = useState(() => new Preloader());

  // 沉浸：静止 2 秒淡出顶栏与缩略图条。指针在二者之上、详细信息面板展开、键盘焦点在顶栏内时不淡出
  // （鼠标点出的焦点不算）
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [overBars, setOverBars] = useState(false);
  const [focusInTop, setFocusInTop] = useState(false);
  // 重命名期间也不淡出
  const renaming = useRename((s) => s.id !== null);
  const idle = useIdle(root, IDLE_MS, overBars || focusInTop || infoOpen || renaming);

  useEffect(
    () => () => {
      preloader.clear();
      cancelSwitch();
    },
    [preloader],
  );

  // 上一次见到的列表：当前图被移除时按它在旧列表里的位置落到新列表的同一位置
  const prevIds = useRef<readonly FileId[]>(list.ids);
  useLayoutEffect(() => {
    const prev = prevIds.current;
    prevIds.current = list.ids;
    if (id === null || prev === list.ids) return;
    const next = resolveCurrent(prev, list.ids, id);
    if (next === null) useNav.getState().back();
    else useNav.getState().setCurrent(next);
  }, [list, id]);

  // 每次换图（或条目的尺寸、版本变化）整体替换想要预解码的集合：滚过去的立即丢弃，不堆积
  const index = id === null ? -1 : list.ids.indexOf(id);
  // 当前图不在列表里（刚被删除，上面的效果已改了当前图，紧接着会以新的当前图重跑）时不动集合，
  // 免得把即将显示的邻居丢掉
  useLayoutEffect(() => {
    if (id === null || index < 0) return;
    const pixelsOf = (x: FileId) => {
      const e = getSingleEntry(x);
      return e?.width && e.height ? e.width * e.height : null;
    };
    const plan = preloadPlan(list.ids, index, pixelsOf);
    preloader.want(
      plan.flatMap((x) => {
        const e = getSingleEntry(x);
        return e ? [{ id: x, url: imageUrl(e) }] : [];
      }),
    );
  }, [id, index, list, entries, basketItems, preloader]);

  return (
    <div
      ref={setRoot}
      className={`single-view${idle ? " idle" : ""}`}
      onPointerOver={(e) => setOverBars((e.target as Element).closest(BARS) !== null)}
      onPointerLeave={() => setOverBars(false)}
      onFocus={(e) => setFocusInTop(keyboardFocusIn(e.target as Element, ".single-topbar"))}
      onBlur={() => setFocusInTop(false)}
    >
      {id !== null && <TopBar id={id} />}
      <div className="single-middle">
        <div className="single-main">
      <div className="single-stage">
        {id !== null && (
          <Stage id={id} preloader={preloader}>
            {index > 0 && <ArrowZone side="left" />}
            {index >= 0 && index < list.ids.length - 1 && <ArrowZone side="right" />}
          </Stage>
        )}
      </div>
      {id !== null && <Filmstrip list={list} current={id} />}
        </div>
        {id !== null && infoOpen && <DetailsPanel id={id} />}
      </div>
      {id !== null && <InfoBar id={id} />}
      <Hint />
    </div>
  );
}
