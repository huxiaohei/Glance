import { create } from "zustand";

/** 窗口内拖拽的状态。count 为 0 即空闲；target 是目录树上的有效目标（相对目录），没有则 null。 */
export interface DragState { count: number; copy: boolean; target: string | null }

export const DRAG_IDLE: DragState = { count: 0, copy: false, target: null };

/** 只在张数、复制与否、目标目录变化时更新；指针位置不进 store（徽标位置直接写 DOM）。 */
export const useDrag = create<DragState>(() => DRAG_IDLE);
