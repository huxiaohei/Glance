import { useRef, useState } from "react";
import { allCommands, type Command } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { useHelp } from "../../app/useKeyboard";
import { t, type MessageKey } from "../../i18n";
import { useModalFocus } from "../common/useModalFocus";
import "./help.css";

/** 适用视图的标签：全部视图，或所列视图（网格、单张与编辑中）。 */
function viewLabel(c: Command): string {
  if (c.views === "all") return t("help.view.all");
  const names: Partial<Record<string, MessageKey>> = { grid: "help.view.grid", single: "help.view.single", edit: "help.view.edit" };
  return c.views.flatMap((v) => (names[v] ? [t(names[v])] : [])).join(" / ");
}

type MouseRow = [action: MessageKey, gesture: MessageKey];

/** 鼠标操作：按视图分组的静态清单（动作、手势）。 */
const MOUSE: [MessageKey, MouseRow[]][] = [
  ["help.view.window", [["help.m.open", "help.g.drop"]]],
  [
    "help.view.grid",
    [
      ["help.m.view", "help.g.dblThumb"],
      ["help.m.rename", "help.g.dblName"],
      ["help.m.addSel", "help.g.modClick"],
      ["help.m.rangeSel", "help.g.shiftClick"],
      ["help.m.boxSel", "help.g.dragEmpty"],
      ["help.m.move", "help.g.dragTree"],
      ["help.m.copy", "help.g.altDragTree"],
      ["help.m.dragOut", "help.g.dragOut"],
      ["help.m.basket", "help.g.basketBtn"],
      ["help.m.more", "help.g.right"],
    ],
  ],
  [
    "help.view.single",
    [
      ["help.m.wheel", "help.g.wheel"],
      ["help.m.zoom", "help.g.modWheel"],
      ["help.m.pan", "help.g.drag"],
      ["help.m.fit", "help.g.dbl"],
    ],
  ],
  [
    "help.view.compare",
    [
      ["help.m.cellView", "help.g.dblCell"],
      ["help.m.reorder", "help.g.dragCell"],
    ],
  ],
];

const MODS = { mod: IS_MAC ? "⌘" : "Ctrl", alt: IS_MAC ? "⌥" : "Ctrl" };

function MouseList() {
  return (
    <>
      {MOUSE.map(([view, rows]) => (
        <section key={view} className="help-group">
          <h3 className="help-cat">{t(view)}</h3>
          {rows.map(([action, gesture]) => (
            <div key={action + gesture} className="help-row">
              <span>{t(action)}</span>
              <span className="help-gesture">{t(gesture, MODS)}</span>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/** 快捷键一览：没有快捷键的命令不列出；按分类分组，分类内再按适用视图分组并标出视图；都按注册顺序首次出现的先后。 */
function KeyList() {
  const groups = new Map<MessageKey, Map<string, Command[]>>();
  for (const c of allCommands()) {
    if (c.keys.length === 0) continue;
    const byView = groups.get(c.category) ?? new Map<string, Command[]>();
    groups.set(c.category, byView);
    const label = viewLabel(c);
    byView.set(label, [...(byView.get(label) ?? []), c]);
  }

  return (
    <>
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
    </>
  );
}

type Tab = "keys" | "mouse";

/** 帮助：快捷键与鼠标操作两页；`?` 或界面上的“帮助”按钮打开。 */
export default function ShortcutsOverlay() {
  const open = useHelp((s) => s.open);
  const panel = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("keys");
  useModalFocus(panel, open);
  if (!open) return null;

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
        <div className="help-tabs" role="tablist">
          {(["keys", "mouse"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={tab === k ? "help-tab is-active" : "help-tab"}
              onClick={() => setTab(k)}
            >
              {t(k === "keys" ? "help.tab.keys" : "help.tab.mouse")}
            </button>
          ))}
        </div>
        <div role="tabpanel">{tab === "keys" ? <KeyList /> : <MouseList />}</div>
      </div>
    </div>
  );
}
