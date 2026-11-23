import type { FileId } from "../ipc/types";

export const PIXEL_BUDGET = 150_000_000;

/** 宽高未知的图片按 4000×4000 估。 */
const UNKNOWN_PIXELS = 4000 * 4000;
/** 当前图之后依次考虑的偏移：+1、-1、+2、-2。 */
const OFFSETS = [1, -1, 2, -2];

/** 应当保持解码的图片，按优先级：当前、+1、-1、+2、-2。当前图总是在内；其余依次累加像素
 *  （宽高未知按 4000×4000 估），超出预算即停止（后面的都不要）。越界的位置跳过。 */
export function preloadPlan(
  ids: readonly FileId[],
  index: number,
  pixelsOf: (id: FileId) => number | null,
  budget: number = PIXEL_BUDGET,
): FileId[] {
  if (index < 0 || index >= ids.length) return [];
  const px = (id: FileId) => pixelsOf(id) ?? UNKNOWN_PIXELS;
  const plan = [ids[index]];
  let used = px(ids[index]);
  for (const off of OFFSETS) {
    const j = index + off;
    if (j < 0 || j >= ids.length) continue;
    used += px(ids[j]);
    if (used > budget) break;
    plan.push(ids[j]);
  }
  return plan;
}
