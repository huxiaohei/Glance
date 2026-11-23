import { memo } from "react";
import { t } from "../../i18n";
import type { DirNode } from "../../lib/deriveList";
import { useListView } from "../../stores/listView";

interface Props { nodes: DirNode[]; total: number }

function DirTree({ nodes, total }: Props) {
  const visible = useListView((s) => s.treeVisible);
  const filter = useListView((s) => s.dirFilter);
  if (!visible) return null;
  const select = (dir: string | null) => useListView.getState().setDirFilter(dir);

  return (
    <aside className="dir-tree">
      <div className="dir-tree-title">{t("tree.title")}</div>
      <div className="dir-tree-list">
        <button
          type="button"
          className={filter === null ? "dir-item dir-item-active" : "dir-item"}
          onClick={() => select(null)}
        >
          <span className="dir-name">{t("tree.all")}</span>
          <span className="dir-count">{total}</span>
        </button>
        {nodes.map((n) => (
          <button
            key={n.dir}
            type="button"
            className={filter === n.dir ? "dir-item dir-item-active" : "dir-item"}
            style={{ paddingLeft: 12 + n.depth * 16 }}
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
