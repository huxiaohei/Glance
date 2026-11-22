import { useState, type ReactNode } from "react";
import CacheLab from "./CacheLab";
import HugeImageLab from "./HugeImageLab";
import TransportLab from "./TransportLab";

// 实验面板仅供开发使用，不走 i18n。
const tabs: { id: string; title: string; render: () => ReactNode }[] = [
  { id: "transport", title: "传输", render: () => <TransportLab /> },
  { id: "cache", title: "缓存", render: () => <CacheLab /> },
  { id: "huge", title: "大图", render: () => <HugeImageLab /> },
];

const styles = {
  root: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "#1E1E1E",
    color: "#D4D4D4",
    fontSize: 13,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  bar: { display: "flex", gap: 8, padding: 8, borderBottom: "1px solid #333" },
  content: { flex: 1, overflow: "auto", padding: 12 },
} as const;

export default function Lab({ onBack }: { onBack: () => void }) {
  const [active, setActive] = useState<string | null>(tabs[0]?.id ?? null);
  const current = tabs.find((tab) => tab.id === active);
  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <button type="button" onClick={onBack}>
          返回
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={tab.id === active}
            onClick={() => setActive(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div style={styles.content}>{current?.render()}</div>
    </div>
  );
}
