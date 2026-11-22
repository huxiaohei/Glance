import { useState } from "react";
import { t } from "./i18n";
import Lab from "./lab/Lab";

const styles = {
  root: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    background: "#1E1E1E",
    color: "#D4D4D4",
    fontSize: 13,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  lab: {
    position: "fixed",
    right: 12,
    bottom: 12,
    color: "#8A8A8A",
    background: "none",
    border: "none",
  },
} as const;

export default function App() {
  const [view, setView] = useState<"start" | "lab">("start");
  if (import.meta.env.DEV && view === "lab") {
    return <Lab onBack={() => setView("start")} />;
  }
  return (
    <div style={styles.root}>
      <div>{t("app.dropHint")}</div>
      <button type="button">{t("app.openFolder")}</button>
      {import.meta.env.DEV && (
        <button type="button" style={styles.lab} onClick={() => setView("lab")}>
          实验面板
        </button>
      )}
    </div>
  );
}
