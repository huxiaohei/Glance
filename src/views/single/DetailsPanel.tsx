import type { ReactNode } from "react";
import { t, type MessageKey } from "../../i18n";
import type { FileId, ImageDetails } from "../../ipc/types";
import { formatBytes } from "../../lib/formatBytes";
import { useCatalog } from "../../stores/catalog";
import { useImageDetails } from "./useImageDetails";

function Row({ label, children, selectable }: { label: string; children: ReactNode; selectable?: boolean }) {
  return (
    <div className="details-row">
      <div className="details-label">{label}</div>
      <div className={`details-value${selectable ? " details-path" : ""}`}>{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="details-group">
      <h3 className="details-title">{title}</h3>
      {children}
    </section>
  );
}

const dpiText = ([x, y]: [number, number]) => (x === y ? `${x}` : `${x} × ${y}`);

function colorText(d: ImageDetails): string | null {
  const parts = [d.color, d.bitDepth !== null ? `${d.bitDepth} bit` : null].filter((x): x is string => x !== null);
  return parts.length ? parts.join(" · ") : null;
}

/** 右侧详细信息面板：文件、图像、拍摄信息三组；缺失的项不显示。 */
export default function DetailsPanel({ id }: { id: FileId }) {
  const entry = useCatalog((s) => s.entries.get(id));
  const version = entry ? `${entry.mtimeMs}-${entry.size}` : "";
  const { details, loading, error } = useImageDetails(id, version, true);
  const yesNo = (b: boolean) => t(b ? "details.yes" : "details.no");
  const modified = details
    ? new Intl.DateTimeFormat(navigator.language, { dateStyle: "medium", timeStyle: "short" }).format(details.mtimeMs)
    : null;
  const color = details ? colorText(details) : null;

  return (
    <aside className="details-panel" aria-label={t("details.title")}>
      <Group title={t("details.group.file")}>
        {entry && <Row label={t("details.name")}>{entry.name}</Row>}
        {details && (
          <Row label={t("details.path")} selectable>
            {details.path}
          </Row>
        )}
        {entry && <Row label={t("details.size")}>{formatBytes(entry.size)}</Row>}
        {modified && <Row label={t("details.modified")}>{modified}</Row>}
      </Group>
      <Group title={t("details.group.image")}>
        {entry?.width && entry.height && <Row label={t("details.dimensions")}>{`${entry.width} × ${entry.height}`}</Row>}
        {color && <Row label={t("details.color")}>{color}</Row>}
        {details?.hasAlpha != null && <Row label={t("details.alpha")}>{yesNo(details.hasAlpha)}</Row>}
        {details?.dpi && <Row label="DPI">{dpiText(details.dpi)}</Row>}
        {details?.animated && <Row label={t("details.animated")}>{yesNo(true)}</Row>}
      </Group>
      {details && details.exif.length > 0 && (
        <Group title={t("details.group.exif")}>
          {details.exif.map((e) => (
            <Row key={e.key} label={t(`details.exif.${e.key}` as MessageKey)}>
              {e.value}
            </Row>
          ))}
        </Group>
      )}
      {error && <div className="details-error">{t("details.error")}</div>}
      {loading && <div className="details-loading">{t("details.loading")}</div>}
    </aside>
  );
}
