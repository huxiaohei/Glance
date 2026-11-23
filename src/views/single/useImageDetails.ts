import { useEffect, useState } from "react";
import { imageDetails } from "../../ipc/api";
import type { FileId, ImageDetails } from "../../ipc/types";

interface Result {
  details: ImageDetails | null;
  loading: boolean;
  error: boolean;
}

/** 连续切图时这么久内只请求最后一张。 */
const DEBOUNCE_MS = 120;

/** id 或 version 变化时去抖后重新请求；迟到的应答丢弃。只在面板展开（调用方挂载）期间使用。 */
export function useImageDetails(id: FileId, version: string): Result {
  const [state, setState] = useState<{ key: string; details: ImageDetails | null; error: boolean } | null>(null);
  const key = `${id}|${version}`;

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      imageDetails(id).then(
        (details) => {
          if (!stale) setState({ key, details, error: false });
        },
        () => {
          if (!stale) setState({ key, details: null, error: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [id, key]);

  // 只认与当前图对应的结果；换图后旧内容不闪现
  const cur = state?.key === key ? state : null;
  return { details: cur?.details ?? null, loading: cur === null, error: cur?.error ?? false };
}
