import { getSingleList } from "../../app/singleSource";
import { t } from "../../i18n";
import { neighbor } from "../../lib/currentImage";
import { markSwitchStart } from "../../lib/perfMarks";
import { topView, useNav } from "../../stores/nav";
import { useSettings } from "../../stores/settings";
import { showHint } from "./Hint";

export type Step = "prev" | "next" | "first" | "last";

/**
 * 在单张视图来源的有序列表里切图（目录来源时折叠的分组不在列表里；对比篮来源只有一个分组，不提示目录）。到头时：设置了“到头循环”且多于一张则绕到另一端，
 * 否则提示“已是第一张 / 最后一张”；Home / End 不循环。跨分组时提示新分组的目录（根目录用“根目录”）。
 * 不依赖 Stage，滚轮处理（useStageViewport）也从这里调用。
 */
export function go(step: Step): void {
  const top = topView();
  if (top.kind !== "single") return;
  const { ids, groups } = getSingleList();
  const i = ids.indexOf(top.id);
  if (i < 0) return;
  const loop = useSettings.getState().settings.loopAtEnd && ids.length > 1;
  const wrap = (dir: -1 | 1) => neighbor(ids, top.id, dir) ?? (loop ? ids[dir > 0 ? 0 : ids.length - 1] : null);
  const target =
    step === "prev" ? wrap(-1)
    : step === "next" ? wrap(1)
    : step === "first" ? ids[0]
    : ids[ids.length - 1];
  if (target === null || target === top.id) {
    showHint(t(step === "prev" || step === "first" ? "hint.first" : "hint.last"));
    return;
  }
  const j = ids.indexOf(target);
  markSwitchStart();
  useNav.getState().setCurrent(target);
  const groupAt = (k: number) => groups.find((g) => k >= g.start && k < g.start + g.count);
  const to = groupAt(j);
  if (to && to !== groupAt(i)) showHint(to.dir === "" ? t("grid.rootGroup") : to.dir);
}
