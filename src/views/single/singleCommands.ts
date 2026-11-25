import { registerCommands, type Command } from "../../app/commands";
import { topView, useNav } from "../../stores/nav";
import { useSingleUi } from "../../stores/singleUi";
import { go } from "./go";
import { useStageApi, type StageApi } from "./Stage";

export { go, type Step } from "./go";

/** 返回网格：Esc 与顶栏返回按钮共用。不在单张视图时不做事。 */
export function backToGrid(): void {
  if (topView().kind !== "single") return;
  useNav.getState().back();
}

// 命令在应用启动时就注册，没有单张视图时被直接调用也不做事
const withStage = (fn: (api: StageApi) => void) => () => {
  const api = useStageApi.getState().api;
  if (api && topView().kind === "single") fn(api);
};

// 切图命令不忽略自动重复：按住方向键连续切换。缩放与详情面板在编辑模式中照常可用（视图含 "edit"）
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
    views: ["single", "edit"],
    run: withStage((api) => api.zoomBy(1.25)),
  },
  {
    id: "single.zoomOut",
    title: "cmd.single.zoomOut",
    category: "cmd.cat.view",
    keys: ["-"],
    views: ["single", "edit"],
    run: withStage((api) => api.zoomBy(0.8)),
  },
  {
    id: "single.fit",
    title: "cmd.single.fit",
    category: "cmd.cat.view",
    keys: ["0"],
    views: ["single", "edit"],
    run: withStage((api) => api.fit()),
  },
  {
    id: "single.actual",
    title: "cmd.single.actual",
    category: "cmd.cat.view",
    keys: ["1"],
    views: ["single", "edit"],
    run: withStage((api) => api.actual()),
  },
  {
    id: "single.toggleInfo",
    title: "cmd.single.toggleInfo",
    category: "cmd.cat.view",
    keys: ["I"],
    views: ["single", "edit"],
    run: ({ repeat }) => {
      if (!repeat && topView().kind === "single") useSingleUi.getState().toggleInfo();
    },
  },
];

/** 按 id 取单张视图的命令定义（顶栏按钮的提示用）。 */
export function singleCommand(id: string): Command | undefined {
  return singleCommands.find((c) => c.id === id);
}

/** 应用启动时注册一次（命令按视图生效）；返回注销函数。 */
export function registerSingleCommands(): () => void {
  return registerCommands(singleCommands);
}
