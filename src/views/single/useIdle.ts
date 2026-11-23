import { useEffect, useRef, useState } from "react";

/**
 * 鼠标在 el 内静止满 ms 毫秒后返回 true；移动、按下、滚轮或任意按键立即回到 false 并重新计时。
 * pinned 为真时恒为 false。位置没变的 pointermove（WebKit 在指针下的内容变化时会合成）不算活动；
 * 上次的指针位置跨 pinned / el 的变化保留，面板关上后同位置的合成移动也不算。
 * 按下在捕获阶段监听：箭头区域等子元素原生拦下冒泡时也能收到。
 * 按键活动靠 document 上只重置计时的被动监听，不是快捷键。
 */
export function useIdle(el: HTMLElement | null, ms: number, pinned: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const last = useRef({ x: NaN, y: NaN });

  useEffect(() => {
    if (!el || pinned) {
      setIdle(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const activity = () => {
      setIdle(false);
      arm();
    };
    const onMove = (e: PointerEvent) => {
      const p = last.current;
      if (e.clientX === p.x && e.clientY === p.y) return;
      p.x = e.clientX;
      p.y = e.clientY;
      activity();
    };
    const capture = { capture: true, passive: true } as const;
    arm();
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerdown", activity, capture);
    el.addEventListener("wheel", activity, { passive: true });
    document.addEventListener("keydown", activity, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", activity, capture);
      el.removeEventListener("wheel", activity);
      document.removeEventListener("keydown", activity);
    };
  }, [el, ms, pinned]);

  return idle;
}
