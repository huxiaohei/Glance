import { useRef } from "react";
import { allCommands, type Command } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { useHelp } from "../../app/useKeyboard";
import { t, type MessageKey } from "../../i18n";
import { useModalFocus } from "../common/useModalFocus";
import "./help.css";

/** 适用视图的标签：全部视图，或所列视图（目前只有网格与单张）。 */
function viewLabel(c: Command): string {
  if (c.views === "all") return t("help.view.all");
  const names: Partial<Record<string, MessageKey>> = { grid: "help.view.grid", single: "help.view.single" };
  return c.views.flatMap((v) => (names[v] ? [t(names[v])] : [])).join(" / ");
}

/** 快捷键一览：没有快捷键的命令不列出；按分类分组，分类内再按适用视图分组并标出视图；都按注册顺序首次出现的先后。 */
export default function ShortcutsOverlay() {
  const open = useHelp((s) => s.open);
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel, open);
  if (!open) return null;

  const groups = new Map<MessageKey, Map<string, Command[]>>();
  for (const c of allCommands()) {
    if (c.keys.length === 0) continue;
    const byView = groups.get(c.category) ?? new Map<string, Command[]>();
    groups.set(c.category, byView);
    const label = viewLabel(c);
    byView.set(label, [...(byView.get(label) ?? []), c]);
  }

  return (
    <div className="help-backdrop" onClick={() => useHelp.setState({ open: false })}>
      <div
        ref={panel}
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("help.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="help-title">{t("help.title")}</h2>
        {[...groups].map(([category, byView]) => (
          <section key={category} className="help-group">
            <h3 className="help-cat">{t(category)}</h3>
            {[...byView].map(([label, list]) => (
              <div key={label} className="help-view-group">
                <div className="help-view">{label}</div>
                {list.map((c) => (
                  <div key={c.id} className="help-row">
                    <span>{t(c.title)}</span>
                    <kbd className="help-key">{formatKey(c.keys[0], IS_MAC)}</kbd>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
