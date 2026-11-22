import { t } from "./i18n";

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
  },
} as const;

export default function App() {
  return (
    <div style={styles.root}>
      <div>{t("app.dropHint")}</div>
      <button type="button">{t("app.openFolder")}</button>
      {import.meta.env.DEV && (
        <a href="#lab" style={styles.lab}>
          实验面板
        </a>
      )}
    </div>
  );
}
