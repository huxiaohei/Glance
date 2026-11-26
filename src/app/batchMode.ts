import { batchPlan } from "../ipc/api";
import type { BatchOp, FileId } from "../ipc/types";
import { markSwitchStart } from "../lib/perfMarks";
import { noteAnimated } from "../stores/animated";
import { startBatch } from "../stores/batch";
import { currentParams, useEditUi } from "../stores/editUi";
import { topView, useNav } from "../stores/nav";
import { getSingleList } from "./singleSource";

/**
 * 批量模式：复用单张视图的编辑模式。单张视图的来源是 "selection"（选中的图），面板只有压缩、转格式两页，
 * 左右键 / 滚轮 / 缩略图条在选中的图之间切换并以当前页签重开编辑会话；回车开始批量任务，Esc 回网格。
 * 这张图打不开（如动图）时不提示、不退出：画面显示原图，面板照常可调，可继续切图。
 */

const opOf = (tab: string): BatchOp => (tab === "convert" ? "convert" : "compress");

/** 当前页签对应的批量操作。 */
function currentOp(): BatchOp {
  return opOf(useEditUi.getState().tab);
}

/** 以当前页签（重新）打开这张图；失败时不提示，动图记下来（缩略图角标与按钮状态用）。 */
async function openInBatch(id: FileId, keepParams: boolean): Promise<void> {
  const ui = useEditUi.getState();
  const outcome = await ui.open(id, { tab: opOf(ui.tab), keepParams });
  // 只看这一次打开自己的结果：被更新的打开取代时，store 里的状态属于别的图
  if (outcome.kind === "failed" && outcome.error === "animated") noteAnimated(id, true);
}

/** 进入批量模式。ids 按网格顺序；focus 不在 ids 里时从第一张开始。 */
export async function enterBatch(ids: FileId[], focus: FileId, tab: "compress" | "convert"): Promise<void> {
  if (ids.length === 0) return;
  const start = ids.includes(focus) ? focus : ids[0];
  const list = [...ids];
  useEditUi.getState().close();
  useEditUi.setState({ batch: { ids: list, plan: null }, tab });
  useNav.getState().openSingle(start, "selection");
  await Promise.all([openInBatch(start, false), refreshPlan()]);
}

/** 按当前页签重算处理清单；页签或选中的图在应答前变了就丢掉这次结果。 */
export async function refreshPlan(): Promise<void> {
  const batch = useEditUi.getState().batch;
  if (batch === null) return;
  const op = currentOp();
  const ids = batch.ids;
  if (batch.plan !== null) useEditUi.setState({ batch: { ids, plan: null } });
  let plan;
  try {
    plan = await batchPlan(ids, op);
  } catch {
    return;
  }
  const now = useEditUi.getState().batch;
  if (now === null || now.ids !== ids || currentOp() !== op) return;
  useEditUi.setState({ batch: { ids, plan } });
}

/** 切到选中的图里的某一张，以当前页签重开会话（参数沿用当前的）。 */
export function batchGoto(id: FileId): void {
  const top = topView();
  if (useEditUi.getState().batch === null || top.kind !== "single" || top.id === id) return;
  if (!getSingleList().ids.includes(id)) return;
  markSwitchStart();
  useNav.getState().setCurrent(id);
  void openInBatch(id, true);
}

/** 在选中的图里前后切换，到头绕到另一端。 */
export function batchStep(dir: "prev" | "next"): void {
  const top = topView();
  if (useEditUi.getState().batch === null || top.kind !== "single") return;
  const { ids } = getSingleList();
  const n = ids.length;
  if (n < 2) return;
  const i = ids.indexOf(top.id);
  const j = i < 0 ? 0 : (i + (dir === "next" ? 1 : n - 1)) % n;
  batchGoto(ids[j]);
}

/** 退出批量模式：关掉编辑会话、清掉批量状态，回到网格（选中不动）。 */
export function exitBatch(): void {
  const ui = useEditUi.getState();
  if (ui.batch === null) return;
  ui.close();
  useEditUi.setState({ batch: null });
  const top = topView();
  if (top.kind === "single" && top.source === "selection") useNav.getState().back();
}

/** 防止回车连按：开始请求在途时不再发。 */
let starting = false;

/** 开始批量任务：记住参数，按清单开始；成功后回到网格。清单未到或为空时不做事。 */
export async function runBatch(): Promise<void> {
  const ui = useEditUi.getState();
  const plan = ui.batch?.plan;
  if (starting || !plan || plan.process.length === 0) return;
  starting = true;
  try {
    const params = currentParams(ui);
    await ui.commitMemory();
    const ok = await startBatch(plan.process, params);
    if (ok) exitBatch();
  } finally {
    starting = false;
  }
}
