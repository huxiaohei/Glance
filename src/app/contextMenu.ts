import { t } from "../i18n";
import { fsRecentTargets } from "../ipc/api";
import { lastSegment } from "../lib/lastSegment";
import { topView } from "../stores/nav";
import { allCommands } from "./commands";
import { opTargets, pickAndTransfer, transferTo, transferToNewChild, type TransferKind } from "./fileOps";
import { popup } from "./nativeMenu";
import { singleSource } from "./singleSource";

export type MenuNode =
  | { kind: "item"; label: string; accelerator?: string; enabled: boolean; run(): void }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; enabled: boolean; children: MenuNode[] };

/** readOnly：不出改文件的项（重命名、移动到、复制到、删除），用于对比篮来源的单张视图。 */
export interface MenuCtx { view: "grid" | "single"; count: number; recent: string[]; readOnly?: boolean }

/** 命令表里的一条命令做成菜单项：标签与快捷键取自命令表，点击即命令的 run。命令未注册时没有这一项。 */
function commandItem(id: string, enabled: boolean): MenuNode[] {
  const cmd = allCommands().find((c) => c.id === id);
  if (!cmd) return [];
  const accelerator = cmd.keys[0];
  return [
    {
      kind: "item",
      label: t(cmd.title),
      ...(accelerator ? { accelerator } : {}),
      enabled,
      run: () => cmd.run({ shift: false, repeat: false }),
    },
  ];
}

function transferSubmenu(kind: TransferKind, recent: string[]): MenuNode {
  const names = recent.map(lastSegment);
  const items: MenuNode[] = recent.map((path, i) => ({
    kind: "item",
    // 末级目录重名时显示完整路径
    label: names.filter((n) => n === names[i]).length > 1 ? path : names[i],
    enabled: true,
    run: () => void transferTo(kind, { kind: "path", path }),
  }));
  if (items.length > 0) items.push({ kind: "separator" });
  if (kind === "move") {
    items.push({ kind: "item", label: t("menu.newDir"), enabled: true, run: () => void transferToNewChild("move") });
  }
  items.push({ kind: "item", label: t("menu.pickDir"), enabled: true, run: () => void pickAndTransfer(kind) });
  return { kind: "submenu", label: t(kind === "move" ? "menu.moveTo" : "menu.copyTo"), enabled: true, children: items };
}

/** 当前视图与操作对象下的菜单。组之间有分隔线；没有操作对象时为空。 */
export function buildImageMenu(ctx: MenuCtx): MenuNode[] {
  if (ctx.count === 0) return [];
  const single = ctx.count === 1;
  const groups: MenuNode[][] = [
    ctx.view === "grid" ? commandItem("grid.open", single) : [],
    ctx.readOnly ? [] : [
      ...commandItem("file.rename", single),
      transferSubmenu("move", ctx.recent),
      transferSubmenu("copy", ctx.recent),
      ...commandItem("file.trash", true),
    ],
    [
      ...commandItem("file.copyImage", single),
      ...commandItem("file.copyPath", true),
      ...commandItem("file.reveal", single),
    ],
  ];
  const out: MenuNode[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (out.length > 0) out.push({ kind: "separator" });
    out.push(...g);
  }
  return out;
}

/** 取最近目标后弹出菜单；弹出出错不向外抛。 */
export async function showImageMenu(): Promise<void> {
  const count = opTargets().length;
  const view = topView().kind === "single" ? "single" : "grid";
  const recent = await fsRecentTargets().catch(() => [] as string[]);
  const nodes = buildImageMenu({ view, count, recent, readOnly: singleSource() === "basket" });
  if (nodes.length === 0) return;
  try {
    await popup(nodes);
  } catch {
    // 原生菜单弹不出来时没有可做的补救
  }
}
