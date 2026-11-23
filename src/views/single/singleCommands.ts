import { registerCommands, type Command } from "../../app/commands";
import { useNav } from "../../stores/nav";
import { useStageApi, type StageApi } from "./Stage";

const withStage = (fn: (api: StageApi) => void) => () => {
  const api = useStageApi.getState().api;
  if (api) fn(api);
};

const singleCommands: Command[] = [
  {
    id: "single.back",
    title: "cmd.single.back",
    category: "cmd.cat.view",
    keys: ["Escape"],
    views: ["single"],
    run: ({ repeat }) => {
      if (!repeat) useNav.getState().back();
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

/** SingleView 挂载期间注册；返回注销函数。 */
export function registerSingleCommands(): () => void {
  return registerCommands(singleCommands);
}
