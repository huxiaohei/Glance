import { registerCommands, type Command } from "../../app/commands";
import { getImageList } from "../../app/useImageList";
import { t } from "../../i18n";
import { markSwitchStart } from "../../lib/perfMarks";
import { topView, useNav } from "../../stores/nav";
import { showHint } from "./Hint";
import { useStageApi, type StageApi } from "./Stage";

export type Step = "prev" | "next" | "first" | "last";

/**
 * 在共享的有序列表里切图（折叠的分组不在列表里）。到头不循环，提示“已是第一张 / 最后一张”；
 * 跨分组时提示新分组的目录（根目录用“根目录”）。
 */
export function go(step: Step): void {
  const top = topView();
  if (top.kind !== "single") return;
  const { ids, groups } = getImageList();
  const i = ids.indexOf(top.id);
  if (i < 0) return;
  const j = step === "prev" ? i - 1 : step === "next" ? i + 1 : step === "first" ? 0 : ids.length - 1;
  if (j < 0 || j >= ids.length || j === i) {
    showHint(t(step === "prev" || step === "first" ? "hint.first" : "hint.last"));
    return;
  }
  markSwitchStart();
  useNav.getState().setCurrent(ids[j]);
  const groupAt = (k: number) => groups.find((g) => k >= g.start && k < g.start + g.count);
  const to = groupAt(j);
  if (to && to !== groupAt(i)) showHint(to.dir === "" ? t("grid.rootGroup") : to.dir);
}

/** 返回网格：Esc 与顶栏返回按钮共用。 */
export function backToGrid(): void {
  useNav.getState().back();
}

const withStage = (fn: (api: StageApi) => void) => () => {
  const api = useStageApi.getState().api;
  if (api) fn(api);
};

// 切图命令不忽略自动重复：按住方向键连续切换
const singleCommands: Command[] = [
  {
    id: "single.prev",
    title: "cmd.single.prev",
    category: "cmd.cat.nav",
    keys: ["ArrowLeft"],
    views: ["single"],
    run: () => go("prev"),
  },
  {
    id: "single.next",
    title: "cmd.single.next",
    category: "cmd.cat.nav",
    keys: ["ArrowRight"],
    views: ["single"],
    run: () => go("next"),
  },
  {
    id: "single.first",
    title: "cmd.single.first",
    category: "cmd.cat.nav",
    keys: ["Home"],
    views: ["single"],
    run: () => go("first"),
  },
  {
    id: "single.last",
    title: "cmd.single.last",
    category: "cmd.cat.nav",
    keys: ["End"],
    views: ["single"],
    run: () => go("last"),
  },
  {
    id: "single.back",
    title: "cmd.single.back",
    category: "cmd.cat.view",
    keys: ["Escape"],
    views: ["single"],
    run: ({ repeat }) => {
      if (!repeat) backToGrid();
    },
  },
  {
    id: "single.zoomIn",
    title: "cmd.single.zoomIn",
    category: "cmd.cat.view",
    keys: ["+", "="],
    views: ["single"],
    run: withStage((api) => api.zoomBy(1.25)),
  },
  {
    id: "single.zoomOut",
    title: "cmd.single.zoomOut",
    category: "cmd.cat.view",
    keys: ["-"],
    views: ["single"],
    run: withStage((api) => api.zoomBy(0.8)),
  },
  {
    id: "single.fit",
    title: "cmd.single.fit",
    category: "cmd.cat.view",
    keys: ["0"],
    views: ["single"],
    run: withStage((api) => api.fit()),
  },
  {
    id: "single.actual",
    title: "cmd.single.actual",
    category: "cmd.cat.view",
    keys: ["1"],
    views: ["single"],
    run: withStage((api) => api.actual()),
  },
];

/** 按 id 取单张视图的命令定义（顶栏按钮的提示用）。 */
export function singleCommand(id: string): Command | undefined {
  return singleCommands.find((c) => c.id === id);
}

/** SingleView 挂载期间注册；返回注销函数。 */
export function registerSingleCommands(): () => void {
  return registerCommands(singleCommands);
}
