import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useImageList } from "../../app/useImageList";
import { t } from "../../i18n";
import type { FileId } from "../../ipc/types";
import { resolveCurrent } from "../../lib/currentImage";
import { cancelSwitch } from "../../lib/perfMarks";
import { preloadPlan } from "../../lib/preloadPlan";
import { useCatalog } from "../../stores/catalog";
import { useNav } from "../../stores/nav";
import Hint from "./Hint";
import InfoBar from "./InfoBar";
import TopBar from "./TopBar";
import { Preloader } from "./preloader";
import Stage, { imageUrl } from "./Stage";
import { go, registerSingleCommands } from "./singleCommands";
import "./single.css";

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

/** 单张视图：显示栈顶 single 的那张图；列表变化时修正当前图，列表空了回到网格。前后各两张预解码。 */
export default function SingleView() {
  const id = useNav((s) => {
    const top = s.stack[s.stack.length - 1];
    return top.kind === "single" ? top.id : null;
  });
  const list = useImageList();
  const entries = useCatalog((s) => s.entries);
  const [preloader] = useState(() => new Preloader());

  useEffect(() => registerSingleCommands(), []);
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
      const e = entries.get(x);
      return e?.width && e.height ? e.width * e.height : null;
    };
    const plan = preloadPlan(list.ids, index, pixelsOf);
    preloader.want(
      plan.flatMap((x) => {
        const e = entries.get(x);
        return e ? [{ id: x, url: imageUrl(e) }] : [];
      }),
    );
  }, [id, index, list, entries, preloader]);

  return (
    <div className="single-view">
      {id !== null && <TopBar id={id} />}
      <div className="single-stage">
        {id !== null && (
          <Stage id={id} preloader={preloader}>
            {index > 0 && <ArrowZone side="left" />}
            {index >= 0 && index < list.ids.length - 1 && <ArrowZone side="right" />}
          </Stage>
        )}
      </div>
      {/* 缩略图条插在这里（画面与信息条之间） */}
      {id !== null && <InfoBar id={id} />}
      <Hint />
    </div>
  );
}
