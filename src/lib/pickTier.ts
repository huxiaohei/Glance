import type { Tier } from "../ipc/types";

/** 格子的物理像素不超过 320 用 320 档，否则 640 档。 */
export function pickTier(cell: number, devicePixelRatio: number): Tier {
  return cell * devicePixelRatio <= 320 ? 320 : 640;
}
