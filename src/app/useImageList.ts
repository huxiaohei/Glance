import { useMemo } from "react";
import { deriveList, type ImageList } from "../lib/deriveList";
import { useCatalog } from "../stores/catalog";
import { useListView } from "../stores/listView";

/** 当前目录按排序、筛选、折叠派生出的有序列表；按 catalog.listVersion（及各选项）缓存。 */
export function useImageList(): ImageList {
  const entries = useCatalog((s) => s.entries);
  const listVersion = useCatalog((s) => s.listVersion);
  const sort = useListView((s) => s.sort);
  const includeSubdirs = useListView((s) => s.includeSubdirs);
  const dirFilter = useListView((s) => s.dirFilter);
  const collapsed = useListView((s) => s.collapsed);
  return useMemo(
    () => deriveList(entries.values(), { sort, includeSubdirs, dirFilter, collapsed }),
    [listVersion, sort, includeSubdirs, dirFilter, collapsed],
  );
}
