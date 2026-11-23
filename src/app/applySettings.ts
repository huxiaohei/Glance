import type { Settings } from "../ipc/types";
import { useListView } from "../stores/listView";
import { useSettings } from "../stores/settings";

function applyTheme(s: Settings): void {
  document.documentElement.dataset.theme = s.theme;
}

/** 立即按当前设置应用一次，并在设置变化时重新应用；返回取消订阅的函数。 */
export function startApplyingSettings(): () => void {
  const first = useSettings.getState().settings;
  applyTheme(first);
  useListView.getState().setSort(first.defaultSort);

  return useSettings.subscribe((state, prev) => {
    const next = state.settings;
    const old = prev.settings;
    if (next.theme !== old.theme) applyTheme(next);
    // 只在默认排序本身变化时改写，不覆盖用户在工具栏里临时选的排序
    if (next.defaultSort !== old.defaultSort) useListView.getState().setSort(next.defaultSort);
  });
}
