import type { CatalogEvent, OpenErrorCode, RootInfo } from "../ipc/types";

export interface OpenerDeps<T = undefined> {
  openPath(path: string, recursive: boolean, seq: number, onEvent: (e: CatalogEvent) => void): Promise<RootInfo>;
  begin(info: RootInfo, tag?: T): void;
  apply(e: CatalogEvent): void;
  /** 序号起点，测试用；默认 Date.now()，使热重载后的序号仍大于后端见过的值。 */
  seed?: number;
}

/** superseded：被更新的调用取代，调用方应忽略本结果。 */
export interface OpenResult { superseded: boolean; error: OpenErrorCode | null }

const CODES: readonly string[] = ["notFound", "notAnImage", "unreadable"];

/** 后端因已有更新的请求而作废本次打开；只在内部处理，不对用户显示。 */
function isSuperseded(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "superseded";
}

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
export function createOpener<T = undefined>(deps: OpenerDeps<T>) {
  let latest = deps.seed ?? Date.now(); // 序号即调用顺序，同时发给后端
  // 最近一次发起的调用
  let current = 0;  // 最近一次真正 begin 的调用
  return async function open(path: string, recursive: boolean, tag?: T): Promise<OpenResult> {
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
      info = await deps.openPath(path, recursive, mine, onEvent);
    } catch (err) {
      if (isSuperseded(err)) return { superseded: true, error: null };
      return mine === latest ? { superseded: false, error: errorCode(err) } : { superseded: true, error: null };
    }
    if (mine !== latest) return { superseded: true, error: null };
    current = mine;
    deps.begin(info, tag);
    const pending = buffer;
    buffer = null;
    for (const e of pending) deps.apply(e);
    return { superseded: false, error: null };
  };
}
