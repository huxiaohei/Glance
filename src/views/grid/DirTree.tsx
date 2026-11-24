import { memo } from "react";
import { t } from "../../i18n";
import type { DirNode } from "../../lib/deriveList";
import { useDrag } from "../../stores/drag";
import { useListView } from "../../stores/listView";

interface Props { nodes: DirNode[]; total: number }

/** 行的类名：当前筛选的目录加 dir-item-active，拖拽的有效落点加 dir-item-drop。 */
const itemClass = (active: boolean, drop: boolean) =>
  "dir-item" + (active ? " dir-item-active" : "") + (drop ? " dir-item-drop" : "");

function DirTree({ nodes, total }: Props) {
  const visible = useListView((s) => s.treeVisible);
  const filter = useListView((s) => s.dirFilter);
  const dropTarget = useDrag((s) => s.target); // 拖拽中的有效落点（相对目录，"" 为根目录）
  if (!visible) return null;
  const select = (dir: string | null) => useListView.getState().setDirFilter(dir);

  return (
    <aside className="dir-tree">
      <div className="dir-tree-title">{t("tree.title")}</div>
      <div className="dir-tree-list">
        <button
          type="button"
          className={itemClass(filter === null, dropTarget === "")}
          data-drop-dir=""
          onClick={() => select(null)}
        >
          <span className="dir-name">{t("tree.all")}</span>
          <span className="dir-count">{total}</span>
        </button>
        {nodes.map((n) => (
          <button
            key={n.dir}
            type="button"
            className={itemClass(filter === n.dir, dropTarget === n.dir)}
            data-drop-dir={n.dir}
            style={{ paddingLeft: 16 + n.depth * 16 }}
            title={n.dir}
            onClick={() => select(n.dir)}
          >
            <span className="dir-name">{n.name}</span>
            <span className="dir-count">{n.total}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default memo(DirTree);
