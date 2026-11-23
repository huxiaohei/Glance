import type { CatalogEvent, OpenErrorCode, RootInfo } from "../ipc/types";

export interface OpenerDeps {
  openPath(path: string, recursive: boolean, onEvent: (e: CatalogEvent) => void): Promise<RootInfo>;
  begin(info: RootInfo): void;
  apply(e: CatalogEvent): void;
}

/** superseded：被更新的调用取代，调用方应忽略本结果。 */
export interface OpenResult { superseded: boolean; error: OpenErrorCode | null }

const CODES: readonly string[] = ["notFound", "notAnImage", "unreadable"];

function errorCode(err: unknown): OpenErrorCode {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && CODES.includes(code) ? (code as OpenErrorCode) : "unreadable";
}

/**
 * 后端事件可能先于 openPath 的结果到达，而 catalog 在 begin 之前会丢弃事件：
 * 这里先暂存，begin 之后按顺序回放。
 * - 尚未 begin 的调用，一旦有更新的调用发起就被取代（其结果不得 begin）。
 * - 已 begin 的会话继续接收事件，直到更新的调用真正 begin（新调用失败不影响它）。
 */
export function createOpener(deps: OpenerDeps) {
  let latest = 0;   // 最近一次发起的调用
  let current = 0;  // 最近一次真正 begin 的调用
  return async function open(path: string, recursive: boolean): Promise<OpenResult> {
    const mine = ++latest;
    let buffer: CatalogEvent[] | null = [];
    const onEvent = (e: CatalogEvent) => {
      if (buffer) {
        if (mine === latest) buffer.push(e);
      } else if (current === mine) {
        deps.apply(e);
      }
    };
    let info: RootInfo;
    try {
      info = await deps.openPath(path, recursive, onEvent);
    } catch (err) {
      return mine === latest ? { superseded: false, error: errorCode(err) } : { superseded: true, error: null };
    }
    if (mine !== latest) return { superseded: true, error: null };
    current = mine;
    deps.begin(info);
    const pending = buffer;
    buffer = null;
    for (const e of pending) deps.apply(e);
    return { superseded: false, error: null };
  };
}
