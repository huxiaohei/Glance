import { Fragment, useSyncExternalStore } from "react";
import { allCommands, commandsVersion, subscribeCommands } from "../../app/commands";
import { IS_MAC, formatKey } from "../../app/keys";
import { t, type MessageKey } from "../../i18n";
import type { Hint, HintId } from "../../lib/keyHints";
import "./keyHints.css";

/** 命令的显示键：macOS 上若有退格（⌫）优先用它，其余取第一个键。命令未注册或没有键返回 null。 */
function commandKey(id: string): string | null {
  const cmd = allCommands().find((c) => c.id === id);
  if (!cmd || cmd.keys.length === 0) return null;
  const key = IS_MAC && cmd.keys.includes("Backspace") ? "Backspace" : cmd.keys[0];
  return formatKey(key, IS_MAC);
}

/** 一条提示要显示的键（可能多个）；取不到时返回 null，这条不显示。 */
function hintKeys(id: HintId): string[] | null {
  switch (id) {
    case "basket.add":
    case "basket.remove": {
      const k = commandKey("basket.toggle");
      return k ? [k] : null;
    }
    case "compare.open": {
      const k = commandKey("basket.open");
      return k ? [k] : null;
    }
    case "grid.open": {
      const k = commandKey("grid.open");
      return k ? [k] : null;
    }
    case "single.switch": {
      const prev = commandKey("single.prev");
      const next = commandKey("single.next");
      return prev && next ? [prev, next] : null;
    }
    case "compare.sync": {
      const k = commandKey("compare.toggleSync");
      return k ? [k] : null;
    }
    case "compare.remove": {
      const k = commandKey("compare.remove");
      return k ? [k] : null;
    }
    case "compare.zoom":
      return [`${IS_MAC ? "⌘" : "Ctrl"} ${t("hint.key.wheel")}`];
    case "compare.pan":
      return [t("hint.key.drag")];
  }
}

function hintText(h: Hint): string {
  if (h.id === "basket.add" && h.n === undefined) return t("hint.basket.add1");
  if (h.id === "compare.zoom" && h.solo) return t("hint.compare.zoomSolo");
  const key: MessageKey = `hint.${h.id}`;
  return h.n === undefined ? t(key) : t(key, { n: h.n });
}

/** 底部的快捷键提示：一行不换行，窄时从最后一条起被裁掉。没有可显示的条目时不渲染。 */
export default function KeyHints({ hints }: { hints: Hint[] }) {
  // 命令表变了（例如网格命令晚于本组件注册）时重渲染，重新取键名
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const rows = hints.flatMap((h) => {
    const keys = hintKeys(h.id);
    return keys ? [{ id: h.id, keys, text: hintText(h) }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="key-hints" role="note">
      {rows.map((r) => (
        <span key={r.id} className="key-hint">
          {r.keys.map((k, i) => (
            <Fragment key={i}>
              {i > 0 && " "}
              <kbd aria-hidden="true">{k}</kbd>
            </Fragment>
          ))}{" "}
          <span className="key-hint-text">{r.text}</span>
        </span>
      ))}
    </div>
  );
}
