import { useEffect } from "react";
import { create } from "zustand";

/** 提示显示这么久后消失；再次触发时重新计时。 */
const HINT_MS = 1500;

// seq 每次触发加一：同样的文字再次触发也重新计时
const useHint = create<{ text: string | null; seq: number }>(() => ({ text: null, seq: 0 }));

/** 在单张视图里短暂显示一条提示（到头、跨分组）。 */
export function showHint(text: string): void {
  useHint.setState((s) => ({ text, seq: s.seq + 1 }));
}

/** 单张视图内的提示条。卸载时清掉未消失的提示。 */
export default function Hint() {
  const text = useHint((s) => s.text);
  const seq = useHint((s) => s.seq);

  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => useHint.setState({ text: null }), HINT_MS);
    return () => clearTimeout(timer);
  }, [text, seq]);

  useEffect(() => () => useHint.setState({ text: null }), []);

  if (text === null) return null;
  return (
    <div className="single-hint" role="status">
      {text}
    </div>
  );
}
