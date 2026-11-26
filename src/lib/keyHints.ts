/** 按当前状态预测下一步可能用到的快捷键，按可能性排序，最多三条。只管选哪几条，键名与文字由 KeyHints 组件取。 */
export type HintId =
  | "basket.add"
  | "basket.remove"
  | "compare.open"
  | "grid.open"
  | "single.switch"
  | "compare.zoom"
  | "compare.pan"
  | "compare.sync"
  | "compare.remove"
  | "compare.panel"
  | "panel.move"
  | "panel.toggle"
  | "panel.back"
  | "edit.save"
  | "edit.batchRun"
  | "edit.cancel";
/** solo：只用于 compare.zoom，同步关时为真（文字不带“同步”）。 */
export interface Hint { id: HintId; n?: number; solo?: boolean }

const MAX_HINTS = 3;

/** 网格：有选中时先提示加入（只算未在篮里的张数）或移出对比，再提示进入对比，选中一张时提示放大查看。 */
export function gridHints(s: { selected: number; selectedNotInBasket: number; basket: number }): Hint[] {
  const out: Hint[] = [];
  if (s.selected > 0) {
    out.push(
      s.selectedNotInBasket > 0
        ? { id: "basket.add", n: s.selectedNotInBasket }
        : { id: "basket.remove", n: s.selected },
    );
  }
  if (s.basket > 0) out.push({ id: "compare.open", n: s.basket });
  if (s.selected === 1) out.push({ id: "grid.open" });
  return out.slice(0, MAX_HINTS);
}

/** 单张视图：加入 / 移出对比，篮里有图时进入对比，再是左右切换。 */
export function singleHints(s: { currentInBasket: boolean; basket: number }): Hint[] {
  const out: Hint[] = [{ id: s.currentInBasket ? "basket.remove" : "basket.add" }];
  if (s.basket > 0) out.push({ id: "compare.open", n: s.basket });
  out.push({ id: "single.switch" });
  return out.slice(0, MAX_HINTS);
}

/**
 * 对比视图：缩放（同步关时标 solo）；放大后提示平移；同步开关；面板未开时提示添加面板，否则是移出（放大时被截掉）。
 * sync 缺省为开。键盘焦点在添加面板里（panelFocus）时只提示面板里的键。
 */
export function compareHints(s: { zoomed: boolean; sync?: boolean; panelOpen?: boolean; panelFocus?: boolean }): Hint[] {
  if (s.panelFocus) return [{ id: "panel.move" }, { id: "panel.toggle" }, { id: "panel.back" }];
  const out: Hint[] = [s.sync === false ? { id: "compare.zoom", solo: true } : { id: "compare.zoom" }];
  if (s.zoomed) out.push({ id: "compare.pan" });
  out.push({ id: "compare.sync" }, s.panelOpen ? { id: "compare.remove" } : { id: "compare.panel" });
  return out.slice(0, MAX_HINTS);
}

/** 编辑模式：保存（批量模式下回车是开始处理）与取消（左右切图在单张编辑中不可用，不提示）。 */
export function editHints(s: { batch?: boolean } = {}): Hint[] {
  return [{ id: s.batch ? "edit.batchRun" : "edit.save" }, { id: "edit.cancel" }];
}
