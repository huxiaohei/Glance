import { Fragment, useEffect, useState } from "react";
import { registerAppCommands } from "./app/appCommands";
import { registerFileCommands } from "./app/fileCommands";
import { subscribeThumbs } from "./app/openFolder";
import { startRecentsSync } from "./app/recentsSync";
import { useFolderDrop } from "./app/useFolderDrop";
import { useKeyboard } from "./app/useKeyboard";
import Lab from "./lab/Lab";
import { useCatalog } from "./stores/catalog";
import { useNav } from "./stores/nav";
import { loadRecents } from "./stores/recents";
import { useSettings } from "./stores/settings";
import NamePrompt from "./views/common/NamePrompt";
import GridView from "./views/grid/GridView";
import ShortcutsOverlay from "./views/help/ShortcutsOverlay";
import SettingsDialog from "./views/settings/SettingsDialog";
import SingleView from "./views/single/SingleView";
import { registerSingleCommands } from "./views/single/singleCommands";
import StartView from "./views/start/StartView";
import Toast from "./views/toast/Toast";
import "./app/app.css";

export default function App() {
  const hasRoot = useCatalog((s) => s.root !== null);
  const single = useNav((s) => s.stack[s.stack.length - 1].kind === "single");
  const language = useSettings((s) => s.settings.language);
  const dragging = useFolderDrop();
  const [lab, setLab] = useState(false);
  useKeyboard();

  // 最近目录：启动时读取一次，并开始汇报浏览状态。
  // 应用级、文件操作与单张视图的命令启动时注册一次（单张视图的命令按视图生效），快捷键一览从哪个视图打开都列得全
  useEffect(() => {
    subscribeThumbs();
    const offApp = registerAppCommands();
    const offFile = registerFileCommands();
    const offSingle = registerSingleCommands();
    const stopRecents = startRecentsSync();
    void loadRecents();
    return () => {
      stopRecents();
      offSingle();
      offFile();
      offApp();
    };
  }, []);

  if (import.meta.env.DEV && lab) return <Lab onBack={() => setLab(false)} />;
  return (
    <>
      <Fragment key={language}>
        {/* 有根目录时网格始终挂载；单张视图盖在上面时网格只隐藏，滚动位置与选中保留 */}
        {hasRoot ? <GridView hidden={single} /> : <StartView />}
        {hasRoot && single && <SingleView />}
        <ShortcutsOverlay />
        <SettingsDialog />
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
