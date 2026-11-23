import { recentsNote } from "../ipc/api";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";
import { topView, useNav } from "../stores/nav";
import { useSelection } from "../stores/selection";
import { getImageList } from "./useImageList";

/** 汇报最近目录状态的去抖时长。 */
const DEBOUNCE_MS = 1000;
/** 汇报里带的前几张图（后端据此记下缩略图缓存键）。 */
const FIRST_COUNT = 4;

type Note = Parameters<typeof recentsNote>[0];

let timer: ReturnType<typeof setTimeout> | null = null;
let lastSent: string | null = null;

/** 当前根目录的浏览状态；没有根目录或扫描未结束时为 null。 */
function currentNote(): Note | null {
  const { root, scanning, entries } = useCatalog.getState();
  if (!root || scanning) return null;
  const view = topView();
  const last = view.kind === "single" ? view.id : useSelection.getState().focus;
  const { sort, includeSubdirs } = useListView.getState();
  return {
    generation: root.generation,
    count: entries.size,
    first: getImageList().ids.slice(0, FIRST_COUNT),
    last,
    sort,
    includeSubdirs,
  };
}

/** 发出当前状态；与上一次发出的完全相同就不发。返回的 Promise 在汇报落定后完成，失败静默忽略、从不拒绝。 */
function send(): Promise<void> {
  const note = currentNote();
  if (!note) return Promise.resolve();
  const key = JSON.stringify(note);
  if (key === lastSent) return Promise.resolve();
  lastSent = key;
  return recentsNote(note).catch(() => {});
}

function schedule(): void {
  const { root, scanning } = useCatalog.getState();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  // 没有根目录或正在扫描（换了目录）：已排定的汇报也一并作废
  if (!root || scanning) return;
  timer = setTimeout(() => {
    timer = null;
    void send();
  }, DEBOUNCE_MS);
}

function cancel(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** 订阅目录、视图、选中与列表选项，变化后去抖汇报给后端。返回停止函数。 */
export function startRecentsSync(): () => void {
  lastSent = null;
  const offs = [
    useCatalog.subscribe(schedule),
    useNav.subscribe(schedule),
    useSelection.subscribe(schedule),
    useListView.subscribe(schedule),
  ];
  return () => {
    for (const off of offs) off();
    cancel();
  };
}

/**
 * 有待发的汇报就立刻发出并取消定时器（换目录之前调用，免得丢掉最后的状态）。
 * 在汇报落定后完成，从不拒绝：调用方等它完成再打开新目录，后端才不会因代号已变而丢弃这次汇报。
 */
export function flushRecents(): Promise<void> {
  if (timer === null) return Promise.resolve();
  cancel();
  return send();
}
