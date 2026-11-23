import { useEffect, useLayoutEffect, useRef } from "react";
import { useImageList } from "../../app/useImageList";
import type { FileId } from "../../ipc/types";
import { resolveCurrent } from "../../lib/currentImage";
import { glanceUrl } from "../../lib/glanceUrl";
import { useCatalog } from "../../stores/catalog";
import { useNav } from "../../stores/nav";
import { registerSingleCommands } from "./singleCommands";
import "./single.css";

/** 当前图本身。后续任务换成基于 transform 的缩放视口。 */
function SingleImage({ src }: { src: string }) {
  return <img className="single-img" src={src} alt="" draggable={false} />;
}

/** 单张视图骨架：显示栈顶 single 的那张图；列表变化时修正当前图，列表空了回到网格。 */
export default function SingleView() {
  const id = useNav((s) => {
    const top = s.stack[s.stack.length - 1];
    return top.kind === "single" ? top.id : null;
  });
  const entry = useCatalog((s) => (id === null ? undefined : s.entries.get(id)));
  const list = useImageList();

  useEffect(() => registerSingleCommands(), []);

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

  return (
    <div className="single-view">
      {entry && <SingleImage src={glanceUrl(`image/${entry.id}?v=${entry.mtimeMs}-${entry.size}`)} />}
    </div>
  );
}
