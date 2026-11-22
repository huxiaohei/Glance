import { useState } from "react";
import { glanceUrl } from "../lib/glanceUrl";
import { isImageName, pickAndRegisterDir, protocolHits, type LabEntry } from "./labApi";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** 等网格里所有 <img> 加载完成（成功或失败）。 */
async function settled(root: HTMLElement | null) {
  const deadline = performance.now() + 60_000;
  while (root && performance.now() < deadline) {
    const imgs = Array.from(root.querySelectorAll("img"));
    if (imgs.every((i) => i.complete)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export default function CacheLab() {
  const [entries, setEntries] = useState<LabEntry[]>([]);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [first, setFirst] = useState<number | null>(null);
  const [remount, setRemount] = useState<number | null>(null);

  async function measure(action: () => void | Promise<void>, gridId = "cache-grid") {
    setBusy(true);
    const before = await protocolHits();
    await action();
    await nextFrame();
    await nextFrame();
    await settled(document.getElementById(gridId));
    await new Promise((r) => setTimeout(r, 300));
    const after = await protocolHits();
    setBusy(false);
    return after - before;
  }

  async function pick() {
    const list = await pickAndRegisterDir();
    if (!list) return;
    setEntries(list.filter((e) => isImageName(e.name)));
    setMounted(false);
    setFirst(null);
    setRemount(null);
  }

  async function firstMount() {
    setFirst(await measure(() => setMounted(true)));
    setRemount(null);
  }

  async function reMount() {
    setMounted(false);
    await nextFrame();
    setRemount(await measure(() => setMounted(true)));
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={pick}>
        选择目录
      </button>{" "}
      <button type="button" disabled={busy || mounted || entries.length === 0} onClick={firstMount}>
        首次挂载
      </button>{" "}
      <button type="button" disabled={busy || !mounted} onClick={reMount}>
        卸载再挂载
      </button>
      <p>图片数：{entries.length}</p>
      <ul>
        <li>首次挂载的命中数：{first ?? "—"}</li>
        <li>重新挂载新增的命中数：{remount ?? "—"}</li>
      </ul>
      {mounted && (
        <div id="cache-grid" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {entries.map((e) => (
            <img
              key={e.id}
              src={glanceUrl(`image/${e.id}`)}
              width={96}
              height={96}
              style={{ objectFit: "cover" }}
              alt=""
            />
          ))}
        </div>
      )}
    </div>
  );
}
