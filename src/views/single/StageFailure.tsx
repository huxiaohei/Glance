import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../app/keys";
import { t, type MessageKey } from "../../i18n";
import { imageStatus, openCodecHelp } from "../../ipc/api";
import type { FileId } from "../../ipc/types";
import { codecKindOf, type CodecKind } from "../../lib/codecKind";
import { useThumbs } from "../../stores/thumbs";

type Status = "pending" | "noCodec" | "broken";

const MISSING: Record<CodecKind, MessageKey> = { heif: "codec.missing.heif", avif: "codec.missing.avif" };
const SEARCH_STORE: Record<CodecKind, MessageKey> = { heif: "codec.searchStore.heif", avif: "codec.searchStore.avif" };

/** 说明文字：Windows 上说缺哪个组件（打开商店失败后改说去商店里搜）；macOS 上只有 AVIF 有确切的原因（系统版本）。 */
function missingText(kind: CodecKind | null, searchStore: boolean): string {
  if (kind === null) return t("codec.thumbTip");
  if (IS_MAC) return kind === "avif" ? t("codec.missing.avifMac") : t("codec.thumbTip");
  return t(searchStore ? SEARCH_STORE[kind] : MISSING[kind]);
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/**
 * 原图读不出时画面中央的说明。先问后端原因（imageStatus）：缺系统解码组件 → 说明缺什么，Windows 上加“如何安装”
 * 按钮打开商店页；其实能读（ok，之前的失败是一时的）→ 让预加载器重试一次；其余 → 现有的“无法读取”。
 * 等结果时 HEIC / AVIF 先不显示任何文字，免得“无法读取”一闪而过；其他格式照常先显示“无法读取”。
 */
export default function StageFailure(
  { id, url, name, retry }: { id: FileId; url: string; name: string; retry: () => boolean },
) {
  const kind = codecKindOf(name);
  const known = useThumbs((s) => s.noCodec.has(id));
  const key = `${id}\n${url}`;
  const [result, setResult] = useState<{ key: string; status: Exclude<Status, "pending"> } | null>(null);
  const [searchStore, setSearchStore] = useState<string | null>(null);
  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => imageStatus(id))
      .then(
        (s) => {
          if (!alive) return;
          if (s === "ok" && retryRef.current()) return;
          // 记进缩略图状态：缩略图位置与编辑入口随之认作缺组件
          if (s === "noCodec") useThumbs.getState().apply({ type: "noCodec", id });
          setResult({ key, status: s === "noCodec" ? "noCodec" : "broken" });
        },
        () => {
          if (alive) setResult({ key, status: "broken" });
        },
      );
    return () => {
      alive = false;
    };
  }, [id, key]);

  const status: Status = result?.key === key ? result.status : known ? "noCodec" : kind ? "pending" : "broken";
  if (status === "pending") return null;
  if (status === "broken") return <div className="stage-unreadable">{t("grid.unreadable")}</div>;
  return (
    <div className="stage-codec">
      <p className="stage-codec-text">{missingText(kind, searchStore === key)}</p>
      {!IS_MAC && kind && (
        <button
          type="button"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={() => {
            openCodecHelp(kind).catch(() => setSearchStore(key));
          }}
        >
          {t("codec.howTo")}
        </button>
      )}
    </div>
  );
}
