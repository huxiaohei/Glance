import { openFolder, pickAndOpenFolder, useOpenError } from "../../app/openFolder";
import { t } from "../../i18n";
import type { SortKey } from "../../lib/deriveList";
import { useCatalog } from "../../stores/catalog";
import { CELL_MAX, CELL_MIN, useListView } from "../../stores/listView";

const SORTS: SortKey[] = ["name", "mtime", "size"];

export default function GridToolbar() {
  const root = useCatalog((s) => s.root);
  const scanning = useCatalog((s) => s.scanning);
  const found = useCatalog((s) => s.entries.size);
  const openError = useOpenError((s) => s.error);
  const sort = useListView((s) => s.sort);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const cell = useListView((s) => s.cell);

  const onIncludeSubdirs = (on: boolean) => {
    const { setIncludeSubdirs } = useListView.getState();
    setIncludeSubdirs(on);
    // 当前根是非递归打开的：下级目录还没扫描，需要重新扫描
    if (on && root && !root.recursive) void openFolder(root.path, true);
  };

  return (
    <div className="grid-toolbar">
      <span className="grid-root" title={root?.path}>{root?.name}</span>
      {scanning && <span className="grid-scanning">{t("grid.scanning", { n: found })}</span>}
      {openError && <span className="grid-error">{t(`error.${openError}`)}</span>}
      <span className="grid-spacer" />
      <label className="toolbar-field">
        <span>{t("toolbar.sort")}</span>
        <select value={sort} onChange={(e) => useListView.getState().setSort(e.target.value as SortKey)}>
          {SORTS.map((k) => <option key={k} value={k}>{t(`sort.${k}`)}</option>)}
        </select>
      </label>
      <label className="toolbar-field">
        <input type="checkbox" checked={includeSubdirs} onChange={(e) => onIncludeSubdirs(e.target.checked)} />
        <span>{t("toolbar.includeSubdirs")}</span>
      </label>
      <label className="toolbar-field">
        <span>{t("toolbar.size")}</span>
        <input
          type="range"
          min={CELL_MIN}
          max={CELL_MAX}
          step={1}
          value={cell}
          onChange={(e) => useListView.getState().setCell(Number(e.target.value))}
        />
      </label>
      <button type="button" onClick={() => void pickAndOpenFolder()}>{t("grid.openOther")}</button>
    </div>
  );
}
