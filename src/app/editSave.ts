import type { SaveMode } from "../ipc/types";

/**
 * 保存当前编辑（回车与面板的保存按钮共用）。mode 省略时按设置里的默认保存方式。
 * 保存流程由参数面板一并实现；在此之前什么都不做。
 */
export async function saveEdit(_mode?: SaveMode): Promise<void> {}
