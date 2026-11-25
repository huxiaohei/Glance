import { Fragment, useEffect, useState } from "react";
import { registerAppCommands } from "./app/appCommands";
import { registerBasketCommands } from "./app/basketCommands";
import { registerFileCommands } from "./app/fileCommands";
import { subscribeThumbs } from "./app/openFolder";
import { startOpenRequests } from "./app/openRequests";
import { startRecentsSync } from "./app/recentsSync";
import { startUpdateCheck } from "./app/updateCheck";
import { useFolderDrop } from "./app/useFolderDrop";
import { useKeyboard } from "./app/useKeyboard";
import Lab from "./lab/Lab";
import { useCatalog } from "./stores/catalog";
import { useNav } from "./stores/nav";
import { loadRecents } from "./stores/recents";
import { useSettings } from "./stores/settings";
import NamePrompt from "./views/common/NamePrompt";
import CompareView from "./views/compare/CompareView";
import { registerCompareCommands } from "./views/compare/compareCommands";
import GridView from "./views/grid/GridView";
import ShortcutsOverlay from "./views/help/ShortcutsOverlay";
import SettingsDialog from "./views/settings/SettingsDialog";
import TipDialog from "./views/tip/TipDialog";
import SingleView from "./views/single/SingleView";
import { registerSingleCommands } from "./views/single/singleCommands";
import StartView from "./views/start/StartView";
import Toast from "./views/toast/Toast";
import "./app/app.css";

export default function App() {
  const hasRoot = useCatalog((s) => s.root !== null);
  const topKind = useNav((s) => s.stack[s.stack.length - 1].kind);
  const inCompare = useNav((s) => s.stack.some((v) => v.kind === "compare"));
  const language = useSettings((s) => s.settings.language);
  const dragging = useFolderDrop();
  const [lab, setLab] = useState(false);
  useKeyboard();

  // 应用级、文件操作与单张视图的命令启动时注册一次（单张视图的命令按视图生效），快捷键一览从哪个视图打开都列得全
  useEffect(() => {
    subscribeThumbs();
    const offApp = registerAppCommands();
    const offFile = registerFileCommands();
    const offSingle = registerSingleCommands();
    const offBasket = registerBasketCommands();
    const offCompare = registerCompareCommands();
    // 最近目录：启动时读取一次，并开始汇报浏览状态
    const stopRecents = startRecentsSync();
    void loadRecents();
    // 系统交来的打开请求：启动时取一次，之后每次通知再取
    const stopOpenRequests = startOpenRequests();
    // 更新检查：启动 3 秒后一次，是否真的检查由后端按设置与构建类型决定
    const stopUpdateCheck = startUpdateCheck();
    return () => {
      stopUpdateCheck();
      stopOpenRequests();
      stopRecents();
      offCompare();
      offBasket();
      offSingle();
      offFile();
      offApp();
    };
  }, []);

  if (import.meta.env.DEV && lab) return <Lab onBack={() => setLab(false)} />;
  return (
    <>
      <Fragment key={language}>
        {/* 有根目录时网格始终挂载；对比或单张视图盖在上面时网格只隐藏，滚动位置与选中保留。
            对比视图在栈里就挂着，其上压着对比篮来源的单张视图时同样只隐藏 */}
        {hasRoot ? <GridView hidden={topKind !== "grid"} /> : <StartView />}
        {hasRoot && inCompare && <CompareView hidden={topKind !== "compare"} />}
        {hasRoot && topKind === "single" && <SingleView />}
        <ShortcutsOverlay />
        <SettingsDialog />
        <TipDialog />
        <NamePrompt />
        <Toast />
      </Fragment>
      {dragging && <div className="drop-outline" />}
      {import.meta.env.DEV && (
        <button type="button" className="lab-entry" onClick={() => setLab(true)}>
          实验面板
        </button>
      )}
    </>
  );
}
