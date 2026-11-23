import { useEffect, useState } from "react";
import { pickAndOpenFolder, subscribeThumbs } from "./app/openFolder";
import { useFolderDrop } from "./app/useFolderDrop";
import Lab from "./lab/Lab";
import { useCatalog } from "./stores/catalog";
import GridView from "./views/grid/GridView";
import StartView from "./views/start/StartView";
import "./app/app.css";

export default function App() {
  const hasRoot = useCatalog((s) => s.root !== null);
  const dragging = useFolderDrop();
  const [lab, setLab] = useState(false);

  useEffect(() => {
    subscribeThumbs();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pickAndOpenFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (import.meta.env.DEV && lab) return <Lab onBack={() => setLab(false)} />;
  return (
    <>
      {hasRoot ? <GridView /> : <StartView />}
      {dragging && <div className="drop-outline" />}
      {import.meta.env.DEV && (
        <button type="button" className="lab-entry" onClick={() => setLab(true)}>
          实验面板
        </button>
      )}
    </>
  );
}
