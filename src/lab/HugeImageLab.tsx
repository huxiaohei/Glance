import { useEffect, useRef, useState } from "react";
import { glanceUrl } from "../lib/glanceUrl";
import { isImageName, pickAndRegisterDir, type LabEntry } from "./labApi";

const BURST_GAP_MS = 300;

export default function HugeImageLab() {
  const [entries, setEntries] = useState<LabEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const sizeText = useRef<HTMLSpanElement>(null);
  const scaleText = useRef<HTMLSpanElement>(null);
  const frameText = useRef<HTMLSpanElement>(null);
  // 变换状态放在 ref 里，事件里直接写 style，不走 React 状态。
  const view = useRef({ x: 0, y: 0, s: 1 });
  const lastWheel = useRef(0);

  // 统计缩放过程中的最长帧间隔。
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let max = 0;
    let inBurst = false;
    const tick = (now: number) => {
      const gap = now - prev;
      prev = now;
      const active = now - lastWheel.current < BURST_GAP_MS;
      if (active && !inBurst) max = 0;
      inBurst = active;
      if (active && gap > max) {
        max = gap;
        if (frameText.current) frameText.current.textContent = max.toFixed(1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function apply() {
    const { x, y, s } = view.current;
    if (img.current) img.current.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    if (scaleText.current) scaleText.current.textContent = `${(s * 100).toFixed(1)}%`;
  }

  function onLoad() {
    const el = img.current;
    const c = box.current;
    if (!el || !c) return;
    if (sizeText.current) sizeText.current.textContent = `${el.naturalWidth} × ${el.naturalHeight}`;
    const s = Math.min(c.clientWidth / el.naturalWidth, c.clientHeight / el.naturalHeight);
    view.current = { x: 0, y: 0, s };
    apply();
  }

  function onWheel(e: React.WheelEvent) {
    const c = box.current;
    if (!c) return;
    lastWheel.current = performance.now();
    const r = c.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const v = view.current;
    const k = Math.exp(-e.deltaY * 0.002);
    const s = Math.min(Math.max(v.s * k, 0.01), 64);
    const f = s / v.s;
    view.current = { x: mx - (mx - v.x) * f, y: my - (my - v.y) * f, s };
    apply();
  }

  function onPointerDown(e: React.PointerEvent) {
    const c = e.currentTarget as HTMLElement;
    c.setPointerCapture(e.pointerId);
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev: PointerEvent) => {
      view.current.x += ev.clientX - lx;
      view.current.y += ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      apply();
    };
    const up = () => {
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
    };
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
  }

  async function pick() {
    const list = await pickAndRegisterDir();
    if (!list) return;
    const imgs = list.filter((e) => isImageName(e.name));
    setEntries(imgs);
    setSelected(imgs[0]?.id ?? null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 80px)" }}>
      <div>
        <button type="button" onClick={pick}>
          选择目录
        </button>{" "}
        <select value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value))}>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <ul>
          <li>
            naturalWidth × naturalHeight：<span ref={sizeText}>—</span>
          </li>
          <li>
            当前缩放比例（CSS 像素 / 图像像素）：<span ref={scaleText}>—</span>
          </li>
          <li>
            缩放过程最长帧间隔：<span ref={frameText}>—</span> ms
          </li>
        </ul>
      </div>
      <div
        ref={box}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        style={{ flex: 1, minHeight: 200, overflow: "hidden", background: "#000", touchAction: "none" }}
      >
        {selected !== null && (
          <img
            key={selected}
            ref={img}
            src={glanceUrl(`image/${selected}`)}
            onLoad={onLoad}
            draggable={false}
            alt=""
            style={{ transformOrigin: "0 0", display: "block", maxWidth: "none" }}
          />
        )}
      </div>
    </div>
  );
}
