import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface LabEntry {
  id: number;
  name: string;
  size: number;
}

/** 弹出目录选择并登记该目录下一层的全部文件；取消返回 null。 */
export async function pickAndRegisterDir(): Promise<LabEntry[] | null> {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string") return null;
  return invoke<LabEntry[]>("lab_register_dir", { path: dir });
}

export const protocolHits = () => invoke<number>("lab_protocol_hits");

export const isImageName = (name: string) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
