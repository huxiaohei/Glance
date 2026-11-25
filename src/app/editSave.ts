import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { editSave } from "../ipc/api";
import type { EditParams, FileId, OutFormat, SaveMode, SaveReport, SrcFormat } from "../ipc/types";
import { useCatalog } from "../stores/catalog";
import { compressUnsupported, currentParams, useEditUi } from "../stores/editUi";
import { topView, useNav } from "../stores/nav";
import { useSettings } from "../stores/settings";
import { showToast, type ToastAction } from "../stores/toast";
import { codeOf, errorText, undoLast } from "./fileOps";
import { getSingleEntry, getSingleList, singleSource } from "./singleSource";

/** 保存后等新文件进列表的最长时间；等不到就停在原图。 */
export const NAV_WAIT_MS = 3000;

const FAMILY: Record<OutFormat, { label: string; canonical: string; exts: string[] }> = {
  png: { label: "PNG", canonical: "png", exts: ["png"] },
  jpeg: { label: "JPEG", canonical: "jpg", exts: ["jpg", "jpeg"] },
  webp: { label: "WebP", canonical: "webp", exts: ["webp"] },
};

/** 输出格式：转格式取目标格式，压缩保持原格式。GIF / BMP 不能压缩，返回 null。 */
export function outFormatOf(src: SrcFormat, params: EditParams): OutFormat | null {
  if (params.op === "convert") return params.format;
  return src === "gif" || src === "bmp" ? null : src;
}

/**
 * 另存对话框的建议文件名与过滤器，与后端保存副本的命名一致：压缩 → `名_compressed.扩展名`；
 * 转格式 → `名.新扩展名`，格式没变 → `名_converted.扩展名`。原扩展名属于输出格式（如 .jpeg、.JPG 之于 JPEG）
 * 时原样保留，否则用 png / jpg / webp。后端不核对另存路径的扩展名，所以过滤器必须与输出格式一致。
 */
export function saveTarget(
  srcName: string,
  src: SrcFormat,
  params: EditParams,
): { name: string; filter: { name: string; extensions: string[] } } {
  const out = outFormatOf(src, params) ?? "png";
  const fam = FAMILY[out];
  const dot = srcName.lastIndexOf(".");
  const stem = dot > 0 ? srcName.slice(0, dot) : srcName;
  const srcExt = dot > 0 ? srcName.slice(dot + 1) : "";
  const ext = fam.exts.includes(srcExt.toLowerCase()) ? srcExt : fam.canonical;
  const sameFormat = src === out;
  const suffix = params.op === "compress" ? "_compressed" : sameFormat ? "_converted" : "";
  const lower = ext.toLowerCase();
  const extensions = [lower, ...fam.exts.filter((e) => e !== lower)];
  return { name: `${stem}${suffix}.${ext}`, filter: { name: fam.label, extensions } };
}

/** 回车与保存按钮的默认方式：按设置。 */
function defaultMode(): SaveMode {
  return useSettings.getState().settings.editSaveMode === "overwrite" ? { kind: "overwrite" } : { kind: "copy" };
}

/** 从点下保存到收尾（含另存对话框）：期间再来的保存一律忽略。 */
let busy = false;

/**
 * 保存当前编辑（回车与面板的保存按钮共用）。mode 省略时按设置里的默认保存方式；
 * saveAs 的 path 不用，先弹系统存储对话框，取消则什么也不做。
 * 成功：记住参数、关闭编辑（之后提示条上的“撤销”立即可用）、提示“已保存 名字”，再按需跳到新文件。
 * 失败：留在编辑模式，面板里显示原因。
 */
export async function saveEdit(mode?: SaveMode): Promise<void> {
  const s = useEditUi.getState();
  if (busy || s.status !== "ready" || s.opened === null || s.id === null || compressUnsupported(s)) return;
  busy = true;
  try {
    await run(mode ?? defaultMode());
  } finally {
    busy = false;
  }
}

async function run(requested: SaveMode): Promise<void> {
  const start = useEditUi.getState();
  const session = start.opened!.session;
  const srcId = start.id!;
  const params = currentParams(start);

  let mode = requested;
  if (requested.kind === "saveAs") {
    const { name, filter } = saveTarget(getSingleEntry(srcId)?.name ?? "image", start.opened!.srcFormat, params);
    let picked: string | null;
    try {
      picked = await saveDialog({ defaultPath: name, filters: [filter] });
    } catch {
      picked = null;
    }
    if (typeof picked !== "string" || picked === "") return;
    // 对话框期间编辑可能已被关掉或换了一张
    const now = useEditUi.getState();
    if (now.status !== "ready" || now.opened?.session !== session) return;
    mode = { kind: "saveAs", path: picked };
  }

  const stillMine = () => {
    const now = useEditUi.getState();
    return now.status === "saving" && now.opened?.session === session;
  };

  useEditUi.setState({ status: "saving", saveError: null });
  let report: SaveReport;
  try {
    report = await editSave(session, params, mode);
  } catch (err) {
    if (!stillMine()) return;
    const code = codeOf(err);
    const text = code === "exists" && mode.kind === "overwrite" ? t("edit.err.overwriteTaken") : errorText(code);
    useEditUi.setState({ status: "ready", saveError: text });
    return;
  }

  // 先记参数（读的是当前页与参数），再关闭编辑；关闭之后撤销才可用
  await useEditUi.getState().commitMemory();
  if (useEditUi.getState().opened?.session === session) useEditUi.getState().close();

  const actions: ToastAction[] = report.token !== null ? [{ label: t("fs.undo"), run: () => void undoLast() }] : [];
  showToast({ text: t("edit.toast.saved", { name: report.name }), ...(actions.length > 0 ? { actions } : {}) });

  if (report.outside || singleSource() !== "folder" || report.id === srcId) return;
  followNewFile(report.id, srcId);
}

/** 新文件进了单张视图的列表就跳过去；最多等 NAV_WAIT_MS，等不到停在原图。用户已经换了图则不跳。 */
function followNewFile(id: FileId, srcId: FileId): void {
  const tryGo = (): boolean => {
    const top = topView();
    if (top.kind !== "single" || top.source !== "folder") return true;
    const ids = getSingleList().ids;
    if (!ids.includes(id)) return false;
    // 覆盖换扩展名时原图已移除，当前图可能被挪到邻居上，这时也跳
    if (top.id === srcId || !ids.includes(srcId)) useNav.getState().setCurrent(id);
    return true;
  };
  if (tryGo()) return;
  let done = false;
  const finish = () => {
    done = true;
    clearTimeout(timer);
    off();
  };
  const off = useCatalog.subscribe(() => {
    if (!done && tryGo()) finish();
  });
  const timer = setTimeout(finish, NAV_WAIT_MS);
}
