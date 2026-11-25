import { useRef, type ReactNode } from "react";
import { t, type MessageKey } from "../../i18n";
import type { Language, Settings, Theme, WheelAction } from "../../ipc/types";
import type { SortKey } from "../../lib/deriveList";
import { updateSettings, useSettings } from "../../stores/settings";
import { useTip } from "../../stores/tip";
import { useModalFocus } from "../common/useModalFocus";
import "./settings.css";

const close = () => useSettings.setState({ open: false });

function Row({ id, label, children }: { id: string; label: MessageKey; children: ReactNode }) {
  return (
    <div className="settings-row">
      <label htmlFor={id}>{t(label)}</label>
      {children}
    </div>
  );
}

function Check({ id, label, field }: { id: string; label: MessageKey; field: "includeSubdirs" | "loopAtEnd" | "checkUpdates" | "compareSyncOnEnter" | "showKeyHints" }) {
  const checked = useSettings((s) => s.settings[field]);
  return (
    <div className="settings-row settings-check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => updateSettings({ [field]: e.target.checked })} />
      <label htmlFor={id}>{t(label)}</label>
    </div>
  );
}

function Select<K extends "theme" | "language" | "defaultSort" | "wheel">({
  id,
  label,
  field,
  options,
}: {
  id: string;
  label: MessageKey;
  field: K;
  options: [Settings[K], string][];
}) {
  const value = useSettings((s) => s.settings[field]);
  return (
    <Row id={id} label={label}>
      <select
        id={id}
        value={value}
        onChange={(e) => updateSettings({ [field]: e.target.value as Settings[K] } as Partial<Settings>)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** 编辑面板的默认保存方式：保存副本 / 覆盖原图（文字与面板按钮共用）。 */
function EditSaveMode() {
  const value = useSettings((s) => s.settings.editSaveMode);
  const options: ["copy" | "overwrite", MessageKey][] = [
    ["copy", "edit.save.copy"],
    ["overwrite", "edit.save.overwrite"],
  ];
  return (
    <div className="settings-row">
      <span id="settings-edit-save-mode">{t("settings.editSaveMode")}</span>
      <div className="settings-radios" role="radiogroup" aria-labelledby="settings-edit-save-mode">
        {options.map(([v, label]) => (
          <label key={v} className="settings-radio">
            <input
              type="radio"
              name="settings-edit-save-mode"
              checked={value === v}
              onChange={() => updateSettings({ editSaveMode: v })}
            />
            {t(label)}
          </label>
        ))}
      </div>
    </div>
  );
}

function ColumnsSelect() {
  const value = useSettings((s) => s.settings.compareColumns);
  return (
    <Row id="settings-compare-columns" label="settings.compareColumns">
      <select
        id="settings-compare-columns"
        value={value}
        onChange={(e) => updateSettings({ compareColumns: Number(e.target.value) })}
      >
        {[2, 3, 4, 5, 6, 7, 8].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** 设置对话框：开合存在 store 里（语言切换重挂视图树后仍然打开），改动即保存。 */
export default function SettingsDialog() {
  const open = useSettings((s) => s.open);
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel, open);
  if (!open) return null;

  const themes: [Theme, string][] = [
    ["dark", t("settings.theme.dark")],
    ["light", t("settings.theme.light")],
    ["system", t("settings.theme.system")],
  ];
  // 语言名用各自的写法，不翻译
  const languages: [Language, string][] = [
    ["system", t("settings.language.system")],
    ["zh-CN", "简体中文"],
    ["en", "English"],
  ];
  const sorts: [SortKey, string][] = [
    ["name", t("sort.name")],
    ["mtime", t("sort.mtime")],
    ["size", t("sort.size")],
  ];
  const wheels: [WheelAction, string][] = [
    ["zoom", t("settings.wheel.zoom")],
    ["switch", t("settings.wheel.switch")],
  ];

  return (
    <div className="settings-backdrop" onClick={close}>
      <div
        ref={panel}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="settings-title">{t("settings.title")}</h2>
        <section className="settings-group">
          <h3 className="settings-cat">{t("settings.group.appearance")}</h3>
          <Select id="settings-theme" label="settings.theme" field="theme" options={themes} />
          <Select id="settings-language" label="settings.language" field="language" options={languages} />
          <Check id="settings-key-hints" label="settings.showKeyHints" field="showKeyHints" />
        </section>
        <section className="settings-group">
          <h3 className="settings-cat">{t("settings.group.browse")}</h3>
          <Check id="settings-subdirs" label="settings.includeSubdirs" field="includeSubdirs" />
          <Select id="settings-sort" label="settings.defaultSort" field="defaultSort" options={sorts} />
          <Check id="settings-loop" label="settings.loopAtEnd" field="loopAtEnd" />
          <Select id="settings-wheel" label="settings.wheel" field="wheel" options={wheels} />
        </section>
        <section className="settings-group">
          <h3 className="settings-cat">{t("settings.group.compare")}</h3>
          <ColumnsSelect />
          <Check id="settings-compare-sync" label="settings.compareSyncOnEnter" field="compareSyncOnEnter" />
        </section>
        <section className="settings-group">
          <h3 className="settings-cat">{t("settings.group.edit")}</h3>
          <EditSaveMode />
        </section>
        <section className="settings-group">
          <h3 className="settings-cat">{t("settings.group.update")}</h3>
          <Check id="settings-updates" label="settings.checkUpdates" field="checkUpdates" />
        </section>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-tip"
            onClick={() => {
              close();
              useTip.setState({ open: true });
            }}
          >
            {t("tip.entry")}
          </button>
          <button type="button" onClick={close}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
