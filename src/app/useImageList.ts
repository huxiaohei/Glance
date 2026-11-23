import { deriveList, type ImageList, type ListOptions } from "../lib/deriveList";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";

interface Key extends ListOptions { listVersion: number }
let cached: { key: Key; list: ImageList } | null = null;

const sameKey = (a: Key, b: Key) =>
  a.listVersion === b.listVersion && a.sort === b.sort && a.includeSubdirs === b.includeSubdirs &&
  a.dirFilter === b.dirFilter && a.collapsed === b.collapsed;

/** 当前目录按排序、筛选、折叠派生出的有序列表。模块级缓存：catalog.listVersion 与各选项不变时
 *  返回同一个对象，网格、单张视图与命令共用一份。尺寸补全不改变 listVersion，不触发重算。 */
export function getImageList(): ImageList {
  const { entries, listVersion } = useCatalog.getState();
  const { sort, includeSubdirs, dirFilter, collapsed } = useListView.getState();
  const key: Key = { listVersion, sort, includeSubdirs, dirFilter, collapsed };
  if (!cached || !sameKey(cached.key, key)) {
    cached = { key, list: deriveList(entries.values(), key) };
  }
  return cached.list;
}

/** 组件里使用：订阅派生所需的输入，返回共享的 getImageList() 结果。 */
export function useImageList(): ImageList {
  useCatalog((s) => s.listVersion);
  useListView((s) => s.sort);
  useListView((s) => s.includeSubdirs);
  useListView((s) => s.dirFilter);
  useListView((s) => s.collapsed);
  return getImageList();
}
