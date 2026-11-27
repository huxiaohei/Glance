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

export const isHeifName = (name: string) => /\.(heic|heif|hif|avif)$/i.test(name);

/** `lab_heic_probe` 的读数：三段耗时（毫秒）、PNG 体积、解码宽高与文件头宽高。 */
export interface HeicProbe {
  readMs: number;
  decodeMs: number;
  encodeMs: number;
  pngBytes: number;
  width: number;
  height: number;
  headerDims: [number, number] | null;
  hasIcc: boolean;
}

export const heicProbe = (path: string) => invoke<HeicProbe>("lab_heic_probe", { path });

/** 弹出目录选择；取消返回 null。 */
export async function pickDir(): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false });
  return typeof dir === "string" ? dir : null;
}

/** 登记目录下一层的文件（只为取得文件名与大小）。 */
export const registerDir = (path: string) => invoke<LabEntry[]>("lab_register_dir", { path });
