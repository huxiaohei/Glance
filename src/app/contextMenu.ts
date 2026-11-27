import { t } from "../i18n";
import { fsRecentTargets } from "../ipc/api";
import { allCodecNames } from "../lib/codecKind";
import { lastSegment } from "../lib/lastSegment";
import { useAnimated } from "../stores/animated";
import { useBasket } from "../stores/basket";
import { useCatalog } from "../stores/catalog";
import { useCompareUi } from "../stores/compareUi";
import { batchRunning } from "../stores/batch";
import { topView } from "../stores/nav";
import { allNoCodec, useThumbs } from "../stores/thumbs";
import { activeView, allCommands } from "./commands";
import { opTargets, pickAndTransfer, readTargets, transferTo, transferToNewChild, type TransferKind } from "./fileOps";
import { popup } from "./nativeMenu";
import { singleSource } from "./singleSource";

export type MenuNode =
  | { kind: "item"; label: string; accelerator?: string; enabled: boolean; run(): void }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; enabled: boolean; children: MenuNode[] };

/** readOnly：不出改文件的项（重命名、移动到、复制到、删除），用于对比篮来源的单张视图。
 *  compare：对比视图，只有“移出对比”与复制图片 / 路径、在访达中显示（同样不出改文件的项）。
 *  removable：对比视图里焦点格在篮内（缺失也算）：count 为 0（焦点缺失）时仍出四项，只有“移出对比”可用。
 *  edit：编辑模式，只有复制图片 / 路径、在访达中显示（不改文件，也不重新进入编辑）。
 *  animated：唯一的操作对象已知是动图，“编辑”置灰。 */
export interface MenuCtx {
  view: "grid" | "single" | "compare" | "edit";
  count: number;
  recent: string[];
  readOnly?: boolean;
  removable?: boolean;
  animated?: boolean;
  /** 批量任务进行中：批量项置灰。 */
  batchBusy?: boolean;
  /** 操作对象的文件名（与 count 一一对应时才有意义）：全是 HEIC / HEIF / AVIF 时“批量压缩…”置灰。 */
  names?: string[];
  /** 操作对象全都缺系统解码组件：编辑与批量项置灰。 */
  noCodec?: boolean;
}

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
  const compare = ctx.view === "compare";
  if (ctx.count === 0 && !(compare && ctx.removable)) return [];
  const single = ctx.count === 1;
  const groups: MenuNode[][] = [
    ctx.view === "grid"
      ? [
          ...commandItem("grid.open", single),
          ...(ctx.count >= 2
            ? [
              ...commandItem("grid.batchCompress", !ctx.batchBusy && !ctx.noCodec && !allCodecNames(ctx.names ?? [])),
              ...commandItem("grid.batchConvert", !ctx.batchBusy && !ctx.noCodec),
            ]
            : commandItem("grid.edit", single && !ctx.animated && !ctx.noCodec)),
        ]
      : [],
    ctx.view === "single" ? commandItem("edit.open", single && !ctx.animated && !ctx.noCodec) : [],
    compare ? commandItem("compare.remove", true) : [],
    ctx.readOnly || compare || ctx.view === "edit" ? [] : [
      ...commandItem("file.rename", single),
      transferSubmenu("move", ctx.recent),
      transferSubmenu("copy", ctx.recent),
      ...commandItem("file.trash", true),
    ],
    [
      ...commandItem("file.copyImage", single),
      ...commandItem("file.copyPath", ctx.count > 0),
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
  const editing = activeView() === "edit";
  const targets = editing ? readTargets() : opTargets();
  const count = targets.length;
  const kind = topView().kind;
  const view = editing ? "edit" : kind === "single" || kind === "compare" ? kind : "grid";
  const animated = count === 1 && useAnimated.getState().ids.has(targets[0]);
  const recent = await fsRecentTargets().catch(() => [] as string[]);
  const focus = useCompareUi.getState().focus;
  const removable = view === "compare" && focus !== null && useBasket.getState().order.includes(focus);
  const names = targets.map((id) => useCatalog.getState().entries.get(id)?.name ?? "");
  const noCodec = allNoCodec(useThumbs.getState().noCodec, targets);
  const nodes = buildImageMenu({
    view, count, recent, names, readOnly: singleSource() === "basket", removable, animated, batchBusy: batchRunning(), noCodec,
  });
  if (nodes.length === 0) return;
  try {
    await popup(nodes);
  } catch {
    // 原生菜单弹不出来时没有可做的补救
  }
}
