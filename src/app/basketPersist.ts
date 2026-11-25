import { basketRestore, basketSave } from "../ipc/api";
import { useBasket } from "../stores/basket";

export const SAVE_DEBOUNCE_MS = 500;

/**
 * 启动时恢复对比篮，之后 order 或 items 变化去抖保存（改名不换 id、顺序不变，
 * 只有 items 变；后端保存时按 Registry 取当前路径）。
 * 任何时刻最多一个 basketSave 在途（后端各次保存在不同线程里，并发会乱序）；
 * 在途期间又有变化，等它结束后再发一次最新的顺序。
 */
export function startBasketPersist(): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let queued = false;

  const send = () => {
    if (stopped) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    let p: Promise<void>;
    try { p = basketSave(useBasket.getState().order); } catch { p = Promise.resolve(); }
    void p.catch(() => {}).then(() => {
      inFlight = false;
      if (queued) { queued = false; send(); }
    });
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; send(); }, SAVE_DEBOUNCE_MS);
  };
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    send();
  };

  void basketRestore()
    .catch(() => [])
    .then((items) => {
      if (stopped) return;
      useBasket.getState().hydrate(items);
      unsubscribe = useBasket.subscribe((state, prev) => {
        if (state.order !== prev.order || state.items !== prev.items) schedule();
      });
      // 恢复期间用户已加入的图：合并后的顺序也要存
      if (useBasket.getState().order.length !== new Set(items.map((i) => i.id)).size) schedule();
    });

  window.addEventListener("pagehide", flush);
  return () => {
    stopped = true;
    unsubscribe?.();
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("pagehide", flush);
  };
}
