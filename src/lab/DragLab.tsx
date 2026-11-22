import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useRef, useState, type PointerEvent } from "react";
import { glanceUrl } from "../lib/glanceUrl";
import { isLeavingWindow, type Point } from "../lib/dragOut";
import { isImageName, pickAndRegisterDir, type LabEntry } from "./labApi";

const START_DISTANCE = 4;

/**
 * 拖拽状态机（用指针事件而非 HTML5 DnD，因为窗口开启了 dragDropEnabled）：
 *   idle ──按下缩略图──▶ pressed ──移动超过 4px──▶ inWindow
 *   inWindow ──指针到达窗口边缘──▶ native（交给系统，本页不再处理指针）
 *   inWindow ──松手──▶ idle（落在目录树占位上则记录"窗口内放下"）
 *   native ──系统拖拽结束 / 失败──▶ idle
 */
type DragState =
  | { kind: "idle" }
  | { kind: "pressed"; entry: LabEntry; origin: Point }
  | { kind: "inWindow"; entry: LabEntry }
  | { kind: "native"; entry: LabEntry };

const pointOf = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });

export default function DragLab() {
  const [entries, setEntries] = useState<LabEntry[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null); // 非空 = 正在窗口内拖拽
  const [overTree, setOverTree] = useState(false);
  const state = useRef<DragState>({ kind: "idle" });
  const treeRef = useRef<HTMLDivElement>(null);
  const say = (line: string) => setLog((prev) => [...prev, line]);

  const reset = () => {
    state.current = { kind: "idle" };
    setCursor(null);
    setOverTree(false);
  };

  const isOverTree = (p: Point) => {
    const r = treeRef.current?.getBoundingClientRect();
    return !!r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  };

  const pick = async () => {
    const picked = await pickAndRegisterDir();
    if (!picked) return;
    setEntries(picked.filter((e) => isImageName(e.name)));
    say(`已登记 ${picked.length} 个文件`);
  };

  const toNative = async (entry: LabEntry, target: HTMLElement, pointerId: number) => {
    state.current = { kind: "native", entry };
    setCursor(null);
    setOverTree(false);
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    try {
      const [path] = await invoke<string[]>("lab_paths", { ids: [entry.id] });
      if (!path) throw new Error("未知 ID");
      await startDrag({ item: [path], icon: path }, (r) =>
        say(`原生拖拽结束：${r.result}`),
      );
      say(`已转为原生拖拽：${entry.name}`);
    } catch (e) {
      say(`原生拖拽失败：${String(e)}`);
    } finally {
      reset();
    }
  };

  const onDown = (entry: LabEntry) => (e: PointerEvent<HTMLElement>) => {
    if (state.current.kind !== "idle" || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    state.current = { kind: "pressed", entry, origin: pointOf(e) };
  };

  const onMove = (e: PointerEvent<HTMLElement>) => {
    const s = state.current;
    const p = pointOf(e);
    if (s.kind === "pressed") {
      if (Math.hypot(p.x - s.origin.x, p.y - s.origin.y) <= START_DISTANCE) return;
      state.current = { kind: "inWindow", entry: s.entry };
      say(`开始窗口内拖拽：${s.entry.name}`);
    }
    const cur = state.current;
    if (cur.kind !== "inWindow") return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (isLeavingWindow(p, viewport)) {
      void toNative(cur.entry, e.currentTarget, e.pointerId);
      return;
    }
    setCursor(p);
    setOverTree(isOverTree(p));
  };

  const onUp = (e: PointerEvent<HTMLElement>) => {
    const s = state.current;
    if (s.kind === "inWindow") {
      say(isOverTree(pointOf(e)) ? "窗口内放下" : "窗口内放下（未落在目录树占位上）");
    }
    if (s.kind !== "native") reset();
  };

  const onCancel = () => {
    if (state.current.kind !== "native") {
      if (state.current.kind === "inWindow") say("窗口内拖拽被取消");
      reset();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      <div>
        <button type="button" onClick={pick}>
          选择目录
        </button>
      </div>
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
        <div
          ref={treeRef}
          style={{
            width: 160,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px dashed #666",
            background: overTree ? "#2D5A8C" : "transparent",
          }}
        >
          目录树占位
        </div>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, 96px)",
            gap: 8,
            alignContent: "start",
          }}
        >
          {entries.map((entry) => (
            <img
              key={entry.id}
              src={glanceUrl(`image/${entry.id}`)}
              alt={entry.name}
              title={entry.name}
              draggable={false}
              onPointerDown={onDown(entry)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
              style={{
                width: 96,
                height: 96,
                objectFit: "cover",
                touchAction: "none",
                userSelect: "none",
                cursor: "grab",
              }}
            />
          ))}
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          height: 140,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          borderTop: "1px solid #333",
        }}
      >
        {log.join("\n")}
      </pre>
      {cursor && (
        <div
          style={{
            position: "fixed",
            left: cursor.x + 12,
            top: cursor.y + 12,
            padding: "4px 8px",
            background: "#333",
            border: "1px solid #888",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          1 张
        </div>
      )}
    </div>
  );
}
