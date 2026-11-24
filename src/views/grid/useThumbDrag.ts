import { useEffect } from "react";
import { captureNames } from "../../app/fileOps";
import { IS_MAC } from "../../app/keys";
import type { FileId } from "../../ipc/types";
import { selectOnly } from "../../lib/selection";
import { dragIds } from "../../lib/thumbDrag";
import { DRAG_IDLE, useDrag } from "../../stores/drag";
import { useGridCtx } from "../../stores/gridCtx";
import { useSelection } from "../../stores/selection";
import { moveBadge } from "./DragBadge";

const THRESHOLD = 4; // 移动超过这个距离（px）才开始拖拽

interface Press {
  pointerId: number;
  id: FileId; // 按下的那张
  startX: number;
  startY: number;
  defer: boolean; // 按下时它已选中且选中多张：没拖就松手时才收成只选它
  active: boolean; // 已超过阈值、正在拖拽
  ids: FileId[]; // 激活时算出的这次拖起来的图（按列表顺序）
  names: Map<FileId, string>; // 激活时取好的文件名，供后续操作的提示条用
}

/**
 * 在缩略图上按下主键并拖动超过 4 px 开始拖拽：徽标跟着指针，松手或取消即结束。
 * 监听挂在 scroller 上（原生监听，先于格子的 React 处理函数执行，所以按下时只读选中、不写）。
 * 激活前不捕获指针（否则双击会落到滚动区上）。enabled 为假（网格被单张视图盖住）时不挂监听，进行中的拖拽就此结束。
 */
export function useThumbDrag(scroller: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!scroller || !enabled) return;
    const el = scroller;
    let press: Press | null = null;

    /** 结束（可重入：释放捕获会再触发 lostpointercapture）。选中不动。 */
    const end = () => {
      const p = press;
      if (!p) return;
      press = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onLost);
      window.removeEventListener("keydown", onKey, true);
      el.removeEventListener("lostpointercapture", onLost);
      if (p.active) {
        el.classList.remove("grid-dragging");
        try { el.releasePointerCapture(p.pointerId); } catch { /* 已释放 */ }
        useDrag.setState(DRAG_IDLE);
      }
    };

    const activate = (p: Press, e: PointerEvent) => {
      p.active = true;
      const sel = useSelection.getState();
      p.ids = dragIds(sel.ids, useGridCtx.getState().list.ids, p.id);
      p.names = captureNames(p.ids);
      moveBadge(e.clientX, e.clientY);
      useDrag.setState({ count: p.ids.length, copy: false, target: null });
      // 捕获指针：拖出滚动区（含窗口外）时仍收得到移动与松开
      try { el.setPointerCapture(p.pointerId); } catch { /* 指针已不在 */ }
      el.addEventListener("lostpointercapture", onLost);
      el.classList.add("grid-dragging");
      window.addEventListener("keydown", onKey, true);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return; // macOS 上 Ctrl + 单击等同右键
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // 带修饰键只是选择操作
      const target = e.target as Element;
      if (target.closest(".rename-input")) return;
      const cellEl = target.closest<HTMLElement>(".thumb-cell");
      if (!cellEl) return;
      end();
      const id = Number(cellEl.dataset.id);
      const sel = useSelection.getState();
      press = {
        pointerId: e.pointerId,
        id,
        startX: e.clientX,
        startY: e.clientY,
        defer: sel.ids.has(id) && sel.ids.size > 1,
        active: false,
        ids: [],
        names: new Map(),
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onLost);
    };

    // 每次指针移动都经过这里；激活后的落点判断（任务 4、5）接在激活分支里
    const onMove = (e: PointerEvent) => {
      const p = press;
      if (!p || e.pointerId !== p.pointerId) return;
      // 主键已经松开却没收到 pointerup（漏掉了）：就此结束
      if ((e.buttons & 1) === 0) {
        end();
        return;
      }
      if (!p.active) {
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) <= THRESHOLD) return;
        activate(p, e);
        return;
      }
      moveBadge(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      const p = press;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.active) {
        if (p.defer) useSelection.getState().set(selectOnly(p.id));
        end();
        return;
      }
      // 已激活：松手（任务 4 在这里接上落点）
      end();
    };

    // pointercancel 与 lostpointercapture：取消，选中不动
    const onLost = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) end();
    };

    // 捕获阶段拦下拖拽中的 Esc，免得同一次按键再触发网格的清空选中命令
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !press?.active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      end();
    };

    el.addEventListener("pointerdown", onDown);
    return () => {
      end();
      el.removeEventListener("pointerdown", onDown);
    };
  }, [scroller, enabled]);
}
