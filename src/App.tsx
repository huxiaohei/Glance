import { useEffect, useState } from "react";
import { registerAppCommands } from "./app/appCommands";
import { subscribeThumbs } from "./app/openFolder";
import { useFolderDrop } from "./app/useFolderDrop";
import { useKeyboard } from "./app/useKeyboard";
import Lab from "./lab/Lab";
import { useCatalog } from "./stores/catalog";
import { useNav } from "./stores/nav";
import GridView from "./views/grid/GridView";
import ShortcutsOverlay from "./views/help/ShortcutsOverlay";
import SingleView from "./views/single/SingleView";
import StartView from "./views/start/StartView";
import "./app/app.css";

export default function App() {
  const hasRoot = useCatalog((s) => s.root !== null);
  const single = useNav((s) => s.stack[s.stack.length - 1].kind === "single");
  const dragging = useFolderDrop();
  const [lab, setLab] = useState(false);
  useKeyboard();

  useEffect(() => {
    subscribeThumbs();
    return registerAppCommands();
  }, []);

  if (import.meta.env.DEV && lab) return <Lab onBack={() => setLab(false)} />;
  return (
    <>
      {/* 有根目录时网格始终挂载；单张视图盖在上面时网格只隐藏，滚动位置与选中保留 */}
      {hasRoot ? <GridView hidden={single} /> : <StartView />}
      {hasRoot && single && <SingleView />}
      <ShortcutsOverlay />
      {dragging && <div className="drop-outline" />}
      {import.meta.env.DEV && (
        <button type="button" className="lab-entry" onClick={() => setLab(true)}>
          实验面板
        </button>
      )}
    </>
  );
}
