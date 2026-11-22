import { useState } from "react";
import { glanceUrl } from "../lib/glanceUrl";
import { median, pickAndRegisterDir, type LabEntry } from "./labApi";

interface Result {
  entry: LabEntry;
  transferMs: number;
  decodeMs: number;
}

const RUNS = 5;

export default function TransportLab() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const entries = await pickAndRegisterDir();
      if (!entries || entries.length === 0) return;
      const entry = entries.reduce((a, b) => (b.size > a.size ? b : a));
      const transfer: number[] = [];
      const decode: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        // 查询串只用来绕开 WebView 缓存，协议侧只看 path。
        const url = glanceUrl(`image/${entry.id}?run=${i}`);
        const t0 = performance.now();
        const res = await fetch(url);
        await res.arrayBuffer();
        transfer.push(performance.now() - t0);
      }
      for (let i = 0; i < RUNS; i++) {
        const img = new Image();
        img.src = glanceUrl(`image/${entry.id}?decode=${i}`);
        const t0 = performance.now();
        await img.decode();
        decode.push(performance.now() - t0);
      }
      setResult({ entry, transferMs: median(transfer), decodeMs: median(decode) });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={run}>
        选择目录（取其中最大的文件）
      </button>
      {busy && <p>测量中…</p>}
      {error && <p style={{ color: "#f66" }}>{error}</p>}
      {result && (
        <ul>
          <li>文件：{result.entry.name}</li>
          <li>大小：{(result.entry.size / 1024 / 1024).toFixed(2)} MB</li>
          <li>传输耗时中位数（{RUNS} 次）：{result.transferMs.toFixed(1)} ms</li>
          <li>解码耗时中位数（{RUNS} 次）：{result.decodeMs.toFixed(1)} ms</li>
        </ul>
      )}
    </div>
  );
}
