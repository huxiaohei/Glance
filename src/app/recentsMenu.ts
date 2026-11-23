import { t } from "../i18n";
import type { RecentEntry } from "../ipc/types";
import type { MenuNode } from "./contextMenu";
import { openRecent, pickAndOpenFolder } from "./openFolder";

/** 工具栏目录名弹出的菜单：其他仍存在的最近目录，加一项“打开其他目录”。 */
export function recentsMenu(list: RecentEntry[], currentPath: string | null): MenuNode[] {
  const items: MenuNode[] = list
    .filter((e) => e.exists && e.path !== currentPath)
    .map((e) => ({
      kind: "item",
      label: `${e.name} — ${e.path}`,
      enabled: true,
      run: () => void openRecent(e),
    }));
  if (items.length > 0) items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: t("grid.openOther"),
    accelerator: "Mod+O",
    enabled: true,
    run: () => void pickAndOpenFolder(),
  });
  return items;
}
