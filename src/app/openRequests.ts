import { onOpenRequest, takeOpenRequest } from "../ipc/api";
import { openFolder } from "./openFolder";

/** 取走系统交来的打开请求（拖到图标、“打开方式”等）；取到路径就打开。路径只原样传给 openFolder。 */
async function take(): Promise<void> {
  try {
    const path = await takeOpenRequest();
    // 路径已被取走：即使调用方已停止也照常打开，丢掉就再也没有了
    if (path !== null) void openFolder(path).catch(() => {});
  } catch {
    // 取失败当作没有请求
  }
}

/** 立刻取一次，并在每次 open_request 事件后再取一次。返回的函数停止监听。 */
export function startOpenRequests(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void take();
  onOpenRequest(() => {
    if (!cancelled) void take();
  })
    .then((fn) => {
      // StrictMode 会先卸载再挂载：注册完成时若已停止，立刻取消
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
