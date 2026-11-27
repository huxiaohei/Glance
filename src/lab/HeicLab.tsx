import { useState } from "react";
import { heicProbe, isHeifName, pickDir, registerDir, type HeicProbe } from "./labApi";

// 实验面板仅供开发使用，不走 i18n。

/** 显示通道的长边上限，与后端 `DISPLAY_MAX_EDGE` 一致。 */
const DISPLAY_MAX_EDGE = 8000;
const BATCH = 50;

interface Row {
  name: string;
  size: number;
  probe?: HeicProbe;
  error?: string;
}

/** 解码宽高与文件头宽高不一致；超过显示上限的图按比例缩小后比较（允许 1 像素的取整误差）。 */
export function dimsMismatch(p: HeicProbe): boolean {
  if (!p.headerDims) return false;
  const [hw, hh] = p.headerDims;
  const long = Math.max(hw, hh);
  if (long > DISPLAY_MAX_EDGE) {
    const k = DISPLAY_MAX_EDGE / long;
    return Math.abs(Math.round(hw * k) - p.width) > 1 || Math.abs(Math.round(hh * k) - p.height) > 1;
  }
  return hw !== p.width || hh !== p.height;
}

const ms = (v: number) => `${v.toFixed(1)} ms`;

/** 最近秩百分位：排序后第 ceil(q × n) 个。 */
const percentile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
};

const cell = { padding: "2px 10px", textAlign: "left" } as const;

export default function HeicLab() {
  const [dir, setDir] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<number[] | null>(null);

  const pick = async () => {
    const picked = await pickDir();
    if (!picked) return;
    setDir(picked);
    setBatch(null);
    setBusy(true);
    try {
      const entries = (await registerDir(picked)).filter((e) => isHeifName(e.name));
      const next: Row[] = entries.map((e) => ({ name: e.name, size: e.size }));
      setRows([...next]);
      for (let i = 0; i < next.length; i++) {
        try {
          next[i] = { ...next[i], probe: await heicProbe(`${picked}/${next[i].name}`) };
        } catch (e) {
          next[i] = { ...next[i], error: String(e) };
        }
        setRows([...next]);
      }
    } finally {
      setBusy(false);
    }
  };

  /** 连续读取 50 张（文件不足就循环取），记每张从发起到解码完成的毫秒数（不含 PNG 编码）。 */
  const runBatch = async () => {
    if (!dir || rows.length === 0) return;
    setBusy(true);
    const times: number[] = [];
    try {
      for (let i = 0; i < BATCH; i++) {
        const row = rows[i % rows.length];
        const t0 = performance.now();
        try {
          const p = await heicProbe(`${dir}/${row.name}`);
          times.push(performance.now() - t0 - p.encodeMs);
        } catch {
          /* 失败的不计入 */
        }
      }
      setBatch(times);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p>
        用法：选择放着 HEIC / HEIF / AVIF 样张的目录（只看这一层），逐个读数。解码宽高 ≠ 文件头宽高的行标红。
        三段耗时：读文件 / 系统解码（长边不超过 8000）/ 不压缩 PNG 编码。
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={busy} onClick={pick}>
          选择目录
        </button>
        <button type="button" disabled={busy || rows.length === 0} onClick={runBatch}>
          连续加载 {BATCH} 张
        </button>
      </div>
      <div>当前目录：{dir ?? "（未选择）"}</div>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>文件</th>
            <th style={cell}>大小</th>
            <th style={cell}>读文件</th>
            <th style={cell}>系统解码</th>
            <th style={cell}>PNG 编码</th>
            <th style={cell}>PNG 体积</th>
            <th style={cell}>解码宽高</th>
            <th style={cell}>文件头宽高</th>
            <th style={cell}>ICC</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = r.probe;
            const bad = p ? dimsMismatch(p) : false;
            return (
              <tr
                key={r.name}
                className={bad ? "lab-mismatch" : undefined}
                style={bad ? { background: "#5A1D1D", color: "#FFB4B4" } : undefined}
              >
                <td style={cell}>{r.name}</td>
                <td style={cell}>{r.size}</td>
                {p ? (
                  <>
                    <td style={cell}>{ms(p.readMs)}</td>
                    <td style={cell}>{ms(p.decodeMs)}</td>
                    <td style={cell}>{ms(p.encodeMs)}</td>
                    <td style={cell}>{p.pngBytes}</td>
                    <td style={cell}>
                      {p.width}×{p.height}
                    </td>
                    <td style={cell}>{p.headerDims ? `${p.headerDims[0]}×${p.headerDims[1]}` : "—"}</td>
                    <td style={cell}>{p.hasIcc ? "有" : "无"}</td>
                  </>
                ) : (
                  <td style={cell} colSpan={7}>
                    {r.error ?? "读取中…"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {batch && (
        <div>
          连续加载（{batch.length} 次成功）：
          {batch.length
            ? `P50 ${ms(percentile(batch, 0.5))}，P95 ${ms(percentile(batch, 0.95))}，最大 ${ms(Math.max(...batch))}`
            : "全部失败"}
        </div>
      )}
    </div>
  );
}
