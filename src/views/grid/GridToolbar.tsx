import { memo } from "react";
import { popup } from "../../app/nativeMenu";
import { openFolder, pickAndOpenFolder } from "../../app/openFolder";
import { recentsMenu } from "../../app/recentsMenu";
import { t } from "../../i18n";
import type { SortKey } from "../../lib/deriveList";
import { useCatalog } from "../../stores/catalog";
import { CELL_MAX, CELL_MIN, useListView } from "../../stores/listView";
import CompareButton from "../common/CompareButton";
import { loadRecents, useRecents } from "../../stores/recents";

const SORTS: SortKey[] = ["name", "mtime", "size"];

function GridToolbar() {
  const root = useCatalog((s) => s.root);
  const scanning = useCatalog((s) => s.scanning);
  const found = useCatalog((s) => s.entries.size);
  const sort = useListView((s) => s.sort);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const cell = useListView((s) => s.cell);

  const onIncludeSubdirs = (on: boolean) => {
    const { setIncludeSubdirs } = useListView.getState();
    setIncludeSubdirs(on);
    // 当前根是非递归打开的：下级目录还没扫描，需要重新扫描
    if (on && root && !root.recursive) {
      void openFolder(root.path, true).then((error) => {
        // 重扫失败：当前仍是非递归的数据，开关恢复成与之一致
        if (error) useListView.getState().setIncludeSubdirs(root.recursive);
      });
    }
  };

  // 用已有的列表立刻弹出菜单，同时在后台重新读取（下次打开菜单时用上），不让点击等后端
  const onPickRoot = async () => {
    void loadRecents();
    await popup(recentsMenu(useRecents.getState().list, root?.path ?? null)).catch(() => {});
  };

  return (
    <div className="grid-toolbar">
      <button type="button" className="grid-root" title={root?.path} onClick={() => void onPickRoot()}>
        {root?.name}
      </button>
      {scanning && <span className="grid-scanning">{t("grid.scanning", { n: found })}</span>}
      <span className="grid-spacer" />
      <label className="toolbar-field">
        <span className="toolbar-label">{t("toolbar.sort")}</span>
        <select aria-label={t("toolbar.sort")} value={sort} onChange={(e) => useListView.getState().setSort(e.target.value as SortKey)}>
          {SORTS.map((k) => <option key={k} value={k}>{t(`sort.${k}`)}</option>)}
        </select>
      </label>
      <label className="toolbar-field">
        <input type="checkbox" checked={includeSubdirs} onChange={(e) => onIncludeSubdirs(e.target.checked)} />
        <span>{t("toolbar.includeSubdirs")}</span>
      </label>
      <label className="toolbar-field">
        <span className="toolbar-label">{t("toolbar.size")}</span>
        <input
          aria-label={t("toolbar.size")}
          type="range"
          min={CELL_MIN}
          max={CELL_MAX}
          step={1}
          value={cell}
          onChange={(e) => useListView.getState().setCell(Number(e.target.value))}
        />
      </label>
      <CompareButton />
      <button type="button" onClick={() => void pickAndOpenFolder()}>{t("grid.openOther")}</button>
    </div>
  );
}

export default memo(GridToolbar);
