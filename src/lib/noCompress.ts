import type { SrcFormat } from "../ipc/types";

/** 这种源格式不能压缩（压缩页只显示说明，批量压缩跳过）。独立成纯函数，编辑状态与保存都用它。 */
export function noCompress(f: SrcFormat): boolean {
  return f === "gif" || f === "bmp" || f === "heif" || f === "avif";
}
