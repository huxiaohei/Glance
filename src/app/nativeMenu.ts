import { Menu } from "@tauri-apps/api/menu";
import { escapeMnemonic } from "../lib/menuLabel";
import { IS_MAC, formatKey } from "./keys";
import type { MenuNode } from "./contextMenu";

type Opts = NonNullable<Parameters<typeof Menu.new>[0]>["items"];

/** 快捷键只拼进标签显示，不交给原生菜单当加速键：否则按键可能与应用自己的按键处理各触发一次。 */
function toItems(nodes: MenuNode[]): NonNullable<Opts> {
  return nodes.map((n) => {
    if (n.kind === "separator") return { item: "Separator" as const };
    if (n.kind === "submenu") return { text: escapeMnemonic(n.label), enabled: n.enabled, items: toItems(n.children) };
    const label = escapeMnemonic(n.label);
    return {
      text: n.accelerator ? `${label}\t${formatKey(n.accelerator, IS_MAC)}` : label,
      enabled: n.enabled,
      action: () => n.run(),
    };
  });
}

/** 上一次弹出的菜单。每个 Menu 在 Rust 侧占一份资源，要显式关闭；但不能在 popup() 返回后马上关：
 *  菜单项的点击是异步送达的，关早了动作就丢了。所以留到下次弹出之前再关。 */
let current: Menu | null = null;

/** 弹出原生右键菜单。很薄的适配层：菜单内容由 contextMenu.ts 决定。 */
export async function popup(nodes: MenuNode[]): Promise<void> {
  const previous = current;
  current = null;
  await previous?.close().catch(() => {});
  const menu = await Menu.new({ items: toItems(nodes) });
  current = menu;
  await menu.popup();
}
