import type { CatalogEvent, OpenErrorCode, RootInfo } from "../ipc/types";

export interface OpenerDeps {
  openPath(path: string, recursive: boolean, onEvent: (e: CatalogEvent) => void): Promise<RootInfo>;
  begin(info: RootInfo): void;
  apply(e: CatalogEvent): void;
}

const CODES: readonly string[] = ["notFound", "notAnImage", "unreadable"];

function errorCode(err: unknown): OpenErrorCode {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && CODES.includes(code) ? (code as OpenErrorCode) : "unreadable";
}

/**
 * 后端事件可能先于 openPath 的结果到达，而 catalog 在 begin 之前会丢弃事件：
 * 这里先暂存，begin 之后按顺序回放。只有最近一次调用有权 begin；被取代的调用其结果和事件一律忽略。
 */
export function createOpener(deps: OpenerDeps) {
  let latest = 0;
  return async function open(path: string, recursive: boolean): Promise<OpenErrorCode | null> {
    const mine = ++latest;
    let buffer: CatalogEvent[] | null = [];
    const onEvent = (e: CatalogEvent) => {
      if (mine !== latest) return;
      if (buffer) buffer.push(e);
      else deps.apply(e);
    };
    let info: RootInfo;
    try {
      info = await deps.openPath(path, recursive, onEvent);
    } catch (err) {
      return mine === latest ? errorCode(err) : null;
    }
    if (mine !== latest) return null;
    deps.begin(info);
    const pending = buffer;
    buffer = null;
    for (const e of pending) deps.apply(e);
    return null;
  };
}
