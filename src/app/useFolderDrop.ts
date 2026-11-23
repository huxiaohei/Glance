import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { openFolder } from "./openFolder";

/** 监听系统拖放（Tauri 原生事件，非 HTML5 DnD）。返回是否正有文件悬停在窗口上。 */
export function useFolderDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else {
          setDragging(false);
          if (p.paths.length > 0) void openFolder(p.paths[0]);
        }
      })
      .then((fn) => {
        // StrictMode 会先卸载再挂载：注册完成时若已卸载，立刻取消
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return dragging;
}
