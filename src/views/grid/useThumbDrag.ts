import { useEffect } from "react";
import { captureNames, isBusy, transferTo } from "../../app/fileOps";
import { IS_MAC } from "../../app/keys";
import { startNativeDrag } from "../../app/nativeDrag";
import type { FileId } from "../../ipc/types";
import { isLeavingWindow } from "../../lib/dragOut";
import { edgeScroll } from "../../lib/marquee";
import { selectOnly } from "../../lib/selection";
import { copyModifier, dragIds, selectModifier, transferPlan } from "../../lib/thumbDrag";
import { useCatalog } from "../../stores/catalog";
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
  lastX: number; // 最后的指针位置（视口坐标）
  lastY: number;
  copy: boolean; // 复制修饰键的实时状态
  target: string | null; // 目录树上的有效落点（相对目录，"" 为根目录）
  plan: FileId[]; // 落在 target 上时实际要处理的图
  carry: number; // 目录树自动滚动累积的不足 1 px 的部分
  tree: HTMLElement | null; // 激活时找到的目录树列表（听它的 scroll）
}

/** 指针下目录树的行所代表的相对目录（"" 为根目录）；不在任何行上为 null。 */
function dropDirAt(x: number, y: number): string | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  return row?.dataset.dropDir ?? null;
}

/**
 * 在缩略图上按下主键并拖动超过 4 px 开始拖拽：徽标跟着指针，松手或取消即结束。
 * 拖到目录树的某一行上松手即移动到该目录（按着 Option / Ctrl 为复制）。落点与目录树的边缘自动滚动每帧至多算一次；
 * 修饰键不动鼠标也生效（激活期间在 window 上听 keydown / keyup），切换的那一刻就重算落点；滚轮滚动目录树时下一帧重算。
 * 拖到窗口边缘 4 px 内：结束窗口内拖拽（同取消），把这批图交给系统拖拽（startNativeDrag）。
 * 监听挂在 scroller 上（原生监听，先于格子的 React 处理函数执行，所以按下时只读选中、不写）。
 * 激活前不捕获指针（否则双击会落到滚动区上）。enabled 为假（网格被单张视图盖住）时不挂监听，进行中的拖拽就此结束。
 */
export function useThumbDrag(scroller: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!scroller || !enabled) return;
    const el = scroller;
    let press: Press | null = null;
    let frame: number | null = null;

    /** 把 press 里的复制与否、落点写进 store（值没变不写）。 */
    const sync = (p: Press) => {
      const cur = useDrag.getState();
      if (cur.copy !== p.copy || cur.target !== p.target) useDrag.setState({ copy: p.copy, target: p.target });
    };

    /** 按最后的指针位置与复制状态重算落点：transferPlan 非空才算有效目标。 */
    const retarget = (p: Press) => {
      const dir = dropDirAt(p.lastX, p.lastY);
      p.plan = dir === null ? [] : transferPlan(p.ids, useCatalog.getState().entries, dir, p.copy);
      p.target = p.plan.length > 0 ? dir : null;
      sync(p);
    };

    const findTree = () => el.closest(".grid-view")?.querySelector<HTMLElement>(".dir-tree-list") ?? null;
    /** 指针在目录树列表的上下边缘带内时滚动它（只滚整像素，到头停）；返回是否还要继续滚。 */
    const scrollTree = (p: Press): boolean => {
      const list = p.tree;
      if (!list) return false;
      const r = list.getBoundingClientRect();
      const inside = p.lastX >= r.left && p.lastX < r.right && p.lastY >= r.top && p.lastY < r.bottom;
      const dy = inside ? edgeScroll(p.lastY, r.top, r.bottom) : 0;
      p.carry = dy === 0 ? 0 : p.carry + dy;
      const step = Math.trunc(p.carry);
      if (step !== 0) {
        list.scrollTop += step;
        p.carry -= step;
      }
      const max = list.scrollHeight - list.clientHeight;
      const atLimit = dy > 0 ? list.scrollTop >= max - 1 : list.scrollTop <= 0;
      return dy !== 0 && !atLimit;
    };

    // 每帧至多一次：目录树边缘自动滚动，再重算落点
    const tick = () => {
      frame = null;
      const p = press;
      if (!p?.active) return;
      const keepScrolling = scrollTree(p);
      retarget(p);
      if (keepScrolling) schedule();
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(tick);
    };

    /** 结束（可重入：释放捕获会再触发 lostpointercapture）。选中不动。 */
    const end = () => {
      const p = press;
      if (!p) return;
      press = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onLost);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      el.removeEventListener("lostpointercapture", onLost);
      p.tree?.removeEventListener("scroll", schedule);
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
      p.copy = copyModifier(e, IS_MAC);
      moveBadge(e.clientX, e.clientY);
      useDrag.setState({ count: p.ids.length, copy: p.copy, target: null });
      // 捕获指针：拖出滚动区（含窗口外）时仍收得到移动与松开
      try { el.setPointerCapture(p.pointerId); } catch { /* 指针已不在 */ }
      el.addEventListener("lostpointercapture", onLost);
      el.classList.add("grid-dragging");
      p.tree = findTree();
      p.tree?.addEventListener("scroll", schedule); // 滚轮滚动目录树而指针不动：指针下的行变了
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
      schedule();
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return; // macOS 上 Ctrl + 单击等同右键
      if (press?.active) return; // 拖拽中别的指针按下：不打断
      if (selectModifier(e)) return; // 带修饰键只是选择操作（与格子的判断同一条）
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
        lastX: e.clientX,
        lastY: e.clientY,
        copy: false,
        target: null,
        plan: [],
        carry: 0,
        tree: null,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onLost);
    };

    // 每次指针移动都经过这里：只记位置、写徽标，落点留给下一帧
    const onMove = (e: PointerEvent) => {
      const p = press;
      if (!p || e.pointerId !== p.pointerId) return;
      // 主键已经松开却没收到 pointerup（漏掉了）：就此结束
      if ((e.buttons & 1) === 0) {
        end();
        return;
      }
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      const activating = !p.active;
      if (activating) {
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) <= THRESHOLD) return;
        activate(p, e);
      }
      // 即将离开窗口：按取消结束窗口内拖拽，剩下的（还在条目表里的）交给系统拖拽
      if (isLeavingWindow({ x: e.clientX, y: e.clientY }, { width: window.innerWidth, height: window.innerHeight })) {
        const entries = useCatalog.getState().entries;
        const ids = p.ids.filter((id) => entries.has(id));
        end();
        startNativeDrag(ids);
        return;
      }
      if (activating) return;
      moveBadge(e.clientX, e.clientY);
      const copy = copyModifier(e, IS_MAC);
      if (copy !== p.copy) {
        p.copy = copy;
        retarget(p); // 当场重算，免得新的复制状态配着旧落点留一帧
      }
      schedule();
    };

    const onUp = (e: PointerEvent) => {
      const p = press;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.active) {
        if (p.defer) useSelection.getState().set(selectOnly(p.id));
        end();
        return;
      }
      // 已激活：按松手那一刻的位置与修饰键算落点（不等下一帧），有效且没有别的操作在进行就移动 / 复制
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      p.copy = copyModifier(e, IS_MAC);
      retarget(p);
      const { target, plan, copy, names } = p;
      end();
      if (target !== null && !isBusy()) void transferTo(copy ? "copy" : "move", { kind: "dir", dir: target }, { ids: plan, names });
    };

    // pointercancel 与 lostpointercapture：取消，选中不动
    const onLost = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) end();
    };

    // 只在拖拽激活期间挂着（keydown / keyup，捕获阶段）：
    // Esc 取消，并拦下它，免得同一次按键再触发网格的清空选中命令；其余按键只跟踪复制修饰键，不拦
    const onKey = (e: KeyboardEvent) => {
      const p = press;
      if (!p?.active) return;
      if (e.key === "Escape") {
        if (e.type !== "keydown") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        end();
        return;
      }
      const copy = copyModifier(e, IS_MAC);
      if (copy === p.copy) return;
      p.copy = copy;
      retarget(p);
    };

    el.addEventListener("pointerdown", onDown);
    return () => {
      end();
      el.removeEventListener("pointerdown", onDown);
    };
  }, [scroller, enabled]);
}
