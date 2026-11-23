import { useEffect, useState } from "react";
import { imageDetails } from "../../ipc/api";
import type { FileId, ImageDetails } from "../../ipc/types";

interface Result {
  details: ImageDetails | null;
  loading: boolean;
  error: boolean;
}

/** enabled 为 false（面板关着）时不请求；id 或 version 变化时重新请求；迟到的应答丢弃。 */
export function useImageDetails(id: FileId, version: string, enabled: boolean): Result {
  const [state, setState] = useState<{ key: string; details: ImageDetails | null; error: boolean } | null>(null);
  const key = `${id}|${version}`;

  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    imageDetails(id).then(
      (details) => {
        if (!stale) setState({ key, details, error: false });
      },
      () => {
        if (!stale) setState({ key, details: null, error: true });
      },
    );
    return () => {
      stale = true;
    };
  }, [id, version, enabled, key]);

  // 只认与当前图对应的结果；换图后旧内容不闪现
  const cur = enabled && state?.key === key ? state : null;
  return { details: cur?.details ?? null, loading: enabled && cur === null, error: cur?.error ?? false };
}
