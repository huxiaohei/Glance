import { useEffect, useState } from "react";

/**
 * 鼠标在 el 内静止满 ms 毫秒后返回 true；移动、按下、滚轮或任意按键立即回到 false 并重新计时。
 * pinned 为真时恒为 false。位置没变的 pointermove（WebKit 在指针下的内容变化时会合成）不算活动。
 * 按键活动靠 document 上只重置计时的被动监听，不是快捷键。
 */
export function useIdle(el: HTMLElement | null, ms: number, pinned: boolean): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!el || pinned) {
      setIdle(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastX = NaN;
    let lastY = NaN;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const activity = () => {
      setIdle(false);
      arm();
    };
    const onMove = (e: PointerEvent) => {
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX;
      lastY = e.clientY;
      activity();
    };
    arm();
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerdown", activity, { passive: true });
    el.addEventListener("wheel", activity, { passive: true });
    document.addEventListener("keydown", activity, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", activity);
      el.removeEventListener("wheel", activity);
      document.removeEventListener("keydown", activity);
    };
  }, [el, ms, pinned]);

  return idle;
}
