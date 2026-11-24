import { create } from "zustand";

export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastSpec {
  /** 主文字 */
  text: string;
  /** 点击后提示条立即关闭 */
  actions?: ToastAction[];
  /** 有则出现“详情”开关，展开后逐行显示 */
  details?: string[];
  /** 加载状态：不自动消失，没有关闭按钮 */
  busy?: boolean;
  /** 不自动消失，但保留关闭按钮（busy 则连关闭按钮也没有） */
  sticky?: boolean;
}

export type CurrentToast = ToastSpec & { key: number };

export const useToast = create<{ current: CurrentToast | null }>(() => ({ current: null }));

/** withBusy 等这么久还没结束才显示加载提示。 */
const BUSY_DELAY_MS = 500;

let nextKey = 0;

/** 显示一条提示，替换正在显示的那条；返回 key。 */
export function showToast(spec: ToastSpec): number {
  const key = ++nextKey;
  useToast.setState({ current: { ...spec, key } });
  return key;
}

/** key 省略时关闭当前这条；给了 key 则只在它仍是当前这条时关闭。 */
export function dismissToast(key?: number): void {
  const cur = useToast.getState().current;
  if (cur === null) return;
  if (key === undefined || cur.key === key) useToast.setState({ current: null });
}

/** 包住一个异步操作：0.5 秒内完成则什么都不显示；超过则显示 busy 提示直到结束。 */
export async function withBusy<T>(text: string, work: Promise<T>): Promise<T> {
  let shown: number | null = null;
  const timer = setTimeout(() => {
    shown = showToast({ text, busy: true });
  }, BUSY_DELAY_MS);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    if (shown !== null) dismissToast(shown);
  }
}
