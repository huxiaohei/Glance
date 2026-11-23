import { Menu } from "@tauri-apps/api/menu";
import { IS_MAC, formatKey } from "./keys";
import type { MenuNode } from "./contextMenu";

type Opts = NonNullable<Parameters<typeof Menu.new>[0]>["items"];

/** 快捷键只拼进标签显示，不交给原生菜单当加速键：否则按键可能与应用自己的按键处理各触发一次。 */
function toItems(nodes: MenuNode[]): NonNullable<Opts> {
  return nodes.map((n) => {
    if (n.kind === "separator") return { item: "Separator" as const };
    if (n.kind === "submenu") return { text: n.label, enabled: n.enabled, items: toItems(n.children) };
    return {
      text: n.accelerator ? `${n.label}\t${formatKey(n.accelerator, IS_MAC)}` : n.label,
      enabled: n.enabled,
      action: () => n.run(),
    };
  });
}

/** 弹出原生右键菜单。很薄的适配层：菜单内容由 contextMenu.ts 决定。 */
export async function popup(nodes: MenuNode[]): Promise<void> {
  const menu = await Menu.new({ items: toItems(nodes) });
  await menu.popup();
}
