import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

interface TrashHandle {
  original: string;
  trashed_at: string | null;
}

// 在打包后的应用里复测：开发模式从终端启动，继承的是终端的磁盘访问权限。
export default function TrashLab() {
  const [file, setFile] = useState<string | null>(null);
  const [handle, setHandle] = useState<TrashHandle | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((prev) => [...prev, line]);

  const pick = async () => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked !== "string") return;
    setFile(picked);
    setHandle(null);
    say(`已选择：${picked}`);
  };

  const trash = async () => {
    if (!file) return;
    try {
      const h = await invoke<TrashHandle>("lab_trash", { path: file });
      setHandle(h);
      say(`移入废纸篓：成功\n${JSON.stringify(h, null, 2)}`);
    } catch (e) {
      say(`移入废纸篓：失败 ${String(e)}`);
    }
  };

  const restore = async () => {
    if (!handle) return;
    try {
      await invoke("lab_restore", { handle });
      say("放回：成功");
    } catch (e) {
      say(`放回：失败 ${String(e)}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={pick}>
          选择文件
        </button>
        <button type="button" disabled={!file} onClick={trash}>
          移入废纸篓
        </button>
        <button type="button" disabled={!handle} onClick={restore}>
          放回
        </button>
      </div>
      <div>当前文件：{file ?? "（未选择）"}</div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}
