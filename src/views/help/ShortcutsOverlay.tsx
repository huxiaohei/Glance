import { allCommands, type Command } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { useHelp } from "../../app/useKeyboard";
import { t, type MessageKey } from "../../i18n";
import "./help.css";

export default function ShortcutsOverlay() {
  const open = useHelp((s) => s.open);
  if (!open) return null;

  const groups = new Map<MessageKey, Command[]>();
  for (const c of allCommands()) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);

  return (
    <div className="help-backdrop" onClick={() => useHelp.setState({ open: false })}>
      <div className="help-panel" role="dialog" aria-label={t("help.title")} onClick={(e) => e.stopPropagation()}>
        <h2 className="help-title">{t("help.title")}</h2>
        {[...groups].map(([category, list]) => (
          <section key={category} className="help-group">
            <h3 className="help-cat">{t(category)}</h3>
            {list.map((c) => (
              <div key={c.id} className="help-row">
                <span>{t(c.title)}</span>
                <kbd className="help-key">{formatKey(c.keys[0], IS_MAC)}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
