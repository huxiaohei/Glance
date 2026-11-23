//! 目录监听的比对：拿到“可能变了”的路径提示后，查看磁盘现状并与已知状态比对，
//! 得出新增、移除、改名与内容变化。只看磁盘、不信事件本身，所以重复的提示是幂等的。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::events::{Entry, RenamedItem};
use super::registry::{FileId, Registry};
use super::scan::{Stamp, is_image_path, is_skipped_path, scan, stamp_of};
use super::session::rel_path;

/// 监听层给出的路径提示。
#[derive(Debug, Clone, PartialEq)]
pub enum FsHint {
    Touched(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
    /// 目录的直接下级可能有消失而没有单独报告的（监听层把“新建后很快改名”
    /// 合并成目标处的一次新建时，源的消失会被吞掉）：列一次目录，已知条目所在的
    /// 直接下级已不存在的移除。只移除、不新增，也不深入子目录。
    Listed(PathBuf),
}

#[derive(Default, Debug, PartialEq)]
pub struct Changes {
    pub removed: Vec<u32>,
    pub renamed: Vec<RenamedItem>,
    /// 新增或内容变化。
    pub upserts: Vec<Entry>,
    /// 与 upserts 一一对应，供补尺寸。
    pub upsert_paths: Vec<(u32, PathBuf)>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.renamed.is_empty() && self.upserts.is_empty()
    }
}

pub struct Reconciler {
    root: PathBuf,
    recursive: bool,
    /// 有序存放：Path 按组成部分比较，目录之下的条目在序列里连续，前缀查询是区间查询。
    known: BTreeMap<PathBuf, (u32, Stamp)>,
    /// 会话的取消标志：子树扫描据此提前结束。
    cancel: Arc<AtomicBool>,
}

/// 一批提示里某个 id 的累计结果。
#[derive(Default)]
struct Outcome {
    /// 本批开始前前端已经知道这个 id。
    was_known: bool,
    removed: bool,
    renamed_to: Option<PathBuf>,
    upsert: Option<(PathBuf, Stamp)>,
}

/// 按 id 合并一批里的结果，保持首次出现的顺序；另存本次 apply 内列过的目录。
#[derive(Default)]
struct Batch {
    order: Vec<u32>,
    outcomes: HashMap<u32, Outcome>,
    /// 目录 → 直接下级的确切名字（None：读不了）。每个目录每次 apply 只列一次。
    listings: HashMap<PathBuf, Option<HashSet<OsString>>>,
    /// 目录 → 已知、但确切名字已不在目录里的直接下级，按大小写无关的名字归类。
    /// 首次需要时建立；用到时再对照 known 核实（本批里可能已经迁走）。
    gone: HashMap<PathBuf, HashMap<String, Vec<OsString>>>,
}

/// 名字的大小写无关形式；不是合法 UTF-8 的名字不参与大小写比较。
fn fold(name: &OsStr) -> Option<String> {
    name.to_str().map(str::to_lowercase)
}

/// 目录直接下级的确切名字；目录读不了，或有任何一项读出错时为 None。
fn read_names(dir: &Path) -> Option<HashSet<OsString>> {
    std::fs::read_dir(dir)
        .ok()?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<_, _>>()
        .ok()
}

impl Batch {
    fn names(&mut self, dir: &Path) -> Option<&HashSet<OsString>> {
        self.listings
            .entry(dir.to_path_buf())
            .or_insert_with(|| read_names(dir))
            .as_ref()
    }

    fn outcome(&mut self, id: u32, was_known: bool) -> &mut Outcome {
        if !self.outcomes.contains_key(&id) {
            self.order.push(id);
        }
        self.outcomes.entry(id).or_insert_with(|| Outcome {
            was_known,
            ..Outcome::default()
        })
    }

    /// 这个 id 是本批里才第一次登记的（前端还没见过）。
    fn is_fresh(&self, id: u32) -> bool {
        self.outcomes.get(&id).is_some_and(|o| !o.was_known)
    }

    fn removed(&mut self, id: u32) {
        let o = self.outcome(id, true);
        o.removed = true;
        o.renamed_to = None;
        o.upsert = None;
    }

    fn renamed(&mut self, id: u32, to: &Path) {
        let o = self.outcome(id, true);
        o.renamed_to = Some(to.to_path_buf());
        if let Some((path, _)) = &mut o.upsert {
            *path = to.to_path_buf();
        }
    }

    fn upsert(&mut self, id: u32, was_known: bool, path: &Path, stamp: Stamp) {
        let o = self.outcome(id, was_known);
        o.removed = false;
        o.upsert = Some((path.to_path_buf(), stamp));
    }

    fn finish(self, root: &Path) -> Changes {
        let mut changes = Changes::default();
        for id in self.order {
            let o = &self.outcomes[&id];
            if o.removed {
                // 本批里新出现又消失的，前端从没见过，不必通知
                if o.was_known {
                    changes.removed.push(id);
                }
                continue;
            }
            // 本批新出现的文件，改名直接体现在 upsert 的路径上
            if let Some(to) = &o.renamed_to
                && o.was_known
            {
                changes.renamed.push(RenamedItem {
                    id,
                    rel_path: rel_path(root, to),
                });
            }
            if let Some((path, stamp)) = &o.upsert {
                changes.upserts.push(Entry {
                    id,
                    rel_path: rel_path(root, path),
                    size: stamp.size,
                    mtime_ms: stamp.mtime_ms,
                });
                changes.upsert_paths.push((id, path.clone()));
            }
        }
        changes
    }
}

impl Reconciler {
    pub fn new(
        root: PathBuf,
        recursive: bool,
        known: HashMap<PathBuf, (u32, Stamp)>,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self {
            root,
            recursive,
            known: known.into_iter().collect(),
            cancel,
        }
    }

    /// 按顺序处理提示，查看磁盘现状并更新 known。同一批里对同一 id 的结果合并：
    /// 最终只出现在 removed、renamed、upserts 之一（renamed 之后内容又变的，两处都出现）。
    ///
    /// 会话取消后尽快返回已得出的部分（子树扫描中途取消时不据此移除任何条目）；
    /// 此时 known 可能只更新了一部分，调用方不应再发出结果，也不应再使用这个比对器。
    pub fn apply(&mut self, hints: &[FsHint], registry: &Registry) -> Changes {
        let mut batch = Batch::default();
        // 一次 apply 期间看到的磁盘是同一个最终状态：先处理全部改名（迁移 id），
        // 再处理 Touched，否则先到的 Touched 会把改名看成“旧的消失、新的出现”。
        // 两类各自保持原有顺序。Listed 最后处理，只移除仍未迁走的已知条目。
        for hint in hints {
            if let FsHint::Renamed { from, to } = hint {
                self.renamed(from, to, registry, &mut batch);
            }
        }
        for hint in hints {
            if self.cancelled() {
                break;
            }
            if let FsHint::Touched(p) = hint {
                self.touched(p, registry, &mut batch);
            }
        }
        for hint in hints {
            if self.cancelled() {
                break;
            }
            if let FsHint::Listed(dir) = hint {
                self.listed(dir, registry, &mut batch);
            }
        }
        batch.finish(&self.root)
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 在监听范围内：root 之下（不含 root 自身）、未被跳过、非递归时是 root 的直接下级。
    fn in_scope(&self, p: &Path) -> bool {
        self.under_root(p)
            && (self.recursive || p.parent() == Some(self.root.as_path()))
            && !is_skipped_path(&self.root, p)
    }

    /// 严格位于 root 之下（不含 root 自身）。
    fn under_root(&self, p: &Path) -> bool {
        p != self.root && p.starts_with(&self.root)
    }

    /// known 里位于目录 dir 之下的条目，按路径有序。dir 之下的条目在 BTreeMap 里
    /// 紧跟 dir 连续排列（如 sub/… 排在 sub.png、sub2 之前），所以是 O(log n + k) 的区间查询。
    fn known_under(&self, dir: &Path) -> Vec<PathBuf> {
        self.known
            .range::<Path, _>((Bound::Excluded(dir), Bound::Unbounded))
            .map(|(k, _)| k)
            .take_while(|k| k.starts_with(dir))
            .cloned()
            .collect()
    }

    /// p 是已知文件，或 p 之下有已知条目。
    fn is_known(&self, p: &Path) -> bool {
        self.known.contains_key(p)
            || self
                .known
                .range::<Path, _>((Bound::Excluded(p), Bound::Unbounded))
                .next()
                .is_some_and(|(k, _)| k.starts_with(p))
    }

    /// p 从 root 往下的每一级是否都以确切的写法出现在上一级目录里。不区分大小写的卷上，
    /// 写法不同的旧路径也能 stat 成功，只有对照目录里的名字才分得出。
    /// 某一级目录读不了时返回 None。
    fn exact_exists(&self, p: &Path, batch: &mut Batch) -> Option<bool> {
        let rel = p.strip_prefix(&self.root).ok()?;
        let mut dir = self.root.clone();
        for c in rel.components() {
            let name = c.as_os_str();
            if !batch.names(&dir)?.contains(name) {
                return Some(false);
            }
            dir.push(name);
        }
        Some(true)
    }

    /// dir 下已知、名字与 name 只差大小写、确切名字已不在目录里的直接下级。
    fn gone_case_variant(&self, dir: &Path, name: &OsStr, batch: &mut Batch) -> Option<PathBuf> {
        let key = fold(name)?;
        if !batch.gone.contains_key(dir) {
            let present = batch.names(dir)?;
            let mut index: HashMap<String, Vec<OsString>> = HashMap::new();
            let mut last: Option<&OsStr> = None;
            for k in self
                .known
                .range::<Path, _>((Bound::Excluded(dir), Bound::Unbounded))
                .map(|(k, _)| k)
                .take_while(|k| k.starts_with(dir))
            {
                let Some(child) = k.strip_prefix(dir).ok().and_then(|r| r.components().next())
                else {
                    continue;
                };
                let child = child.as_os_str();
                // 同一子目录下的条目连续排列，只看一次
                if last == Some(child) {
                    continue;
                }
                last = Some(child);
                if !present.contains(child)
                    && let Some(f) = fold(child)
                {
                    index.entry(f).or_default().push(child.to_os_string());
                }
            }
            batch.gone.insert(dir.to_path_buf(), index);
        }
        batch.gone[dir]
            .get(&key)?
            .iter()
            .map(|n| dir.join(n))
            .find(|c| self.is_known(c))
    }

    /// 已知文件 from 与磁盘上的 to 类型相符（都是图片文件，或 from 是有已知条目的目录、to 是目录）。
    fn same_kind(&self, from: &Path, to: &Path) -> bool {
        let Ok(meta) = std::fs::symlink_metadata(to) else {
            return false;
        };
        if self.known.contains_key(from) {
            meta.is_file() && is_image_path(to)
        } else {
            meta.is_dir()
        }
    }

    /// p 是新出现的确切写法：父目录里有只差大小写、确切名字已消失的已知条目时，
    /// 是一次只改大小写的改名（监听层不给两半配对），把它迁到 p，id 不变。
    fn adopt_case_variant(&mut self, p: &Path, registry: &Registry, batch: &mut Batch) {
        let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else {
            return;
        };
        if let Some(from) = self.gone_case_variant(dir, name, batch)
            && self.same_kind(&from, p)
        {
            self.move_tree(&from, p, registry, batch);
        }
    }

    /// 已知文件 from，或 from 之下的全部已知条目，迁到 to（之下），id 不变；迁不了的移除。
    fn move_tree(&mut self, from: &Path, to: &Path, registry: &Registry, batch: &mut Batch) {
        if self.known.contains_key(from) {
            if !self.move_known(from, to, registry, batch) {
                self.remove(from, batch);
            }
            return;
        }
        for old in self.known_under(from) {
            let new = to.join(old.strip_prefix(from).unwrap_or(&old));
            if !self.move_known(&old, &new, registry, batch) {
                self.remove(&old, batch);
            }
        }
    }

    fn remove(&mut self, p: &Path, batch: &mut Batch) {
        if let Some((id, _)) = self.known.remove(p) {
            batch.removed(id);
        }
    }

    /// p 处的已知文件，或 p 之下的全部已知条目，一并移除。
    fn remove_at(&mut self, p: &Path, batch: &mut Batch) {
        if self.known.contains_key(p) {
            self.remove(p, batch);
        } else {
            for k in self.known_under(p) {
                self.remove(&k, batch);
            }
        }
    }

    fn touched(&mut self, p: &Path, registry: &Registry, batch: &mut Batch) {
        if p == self.root {
            self.rescan(p, self.recursive, registry, batch);
            return;
        }
        if !self.under_root(p) {
            return;
        }
        if !self.in_scope(p) {
            // 仍在 root 之下但已不在范围内（如变成隐藏）：之前登记过的移除
            self.remove_at(p, batch);
            return;
        }
        if !self.is_known(p) {
            // 不区分大小写的卷上旧写法也能 stat 成功：未知路径以目录里的确切名字为准
            match self.exact_exists(p, batch) {
                // 不存在，或只是写法不同的旧路径；未知的也无从移除
                Some(false) => return,
                Some(true) => self.adopt_case_variant(p, registry, batch),
                None => {}
            }
        }
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            // 不存在：已知文件被删，或整个目录被删
            self.remove_at(p, batch);
            return;
        };
        if meta.is_file() && is_image_path(p) {
            match stamp_of(p) {
                Some(stamp) => self.saw_image(p, stamp, registry, batch),
                None => self.remove(p, batch),
            }
        } else if meta.is_dir() {
            // 非递归时子目录不在监听范围内
            if self.recursive {
                self.rescan(p, true, registry, batch);
            }
        } else {
            // 存在但不是图片文件（仅防御，改扩展名走改名分支）
            self.remove(p, batch);
        }
    }

    /// 见 [`FsHint::Listed`]。dir 须是 root 或范围内的目录；读不了，或有任何一项读出错时
    /// 什么也不做。消失的已知下级若在目录里有只差大小写、尚未登记的名字，是一次只改
    /// 大小写的改名，迁过去、id 不变，而不是移除。
    fn listed(&mut self, dir: &Path, registry: &Registry, batch: &mut Batch) {
        if dir != self.root && !(self.recursive && self.in_scope(dir)) {
            return;
        }
        let Some(present) = batch.names(dir).cloned() else {
            return;
        };
        let mut gone: Vec<OsString> = Vec::new();
        for k in self.known_under(dir) {
            let child = k
                .strip_prefix(dir)
                .ok()
                .and_then(|rel| rel.components().next());
            if let Some(c) = child
                && !present.contains(c.as_os_str())
                && gone.last().map(OsString::as_os_str) != Some(c.as_os_str())
            {
                gone.push(c.as_os_str().to_os_string());
            }
        }
        for name in gone {
            let old = dir.join(&name);
            let variant = fold(&name).and_then(|f| {
                present
                    .iter()
                    .map(|n| dir.join(n))
                    .find(|n| {
                        n.file_name().and_then(fold).as_deref() == Some(f.as_str())
                            && !self.is_known(n)
                            && self.in_scope(n)
                    })
            });
            match variant {
                Some(new) if self.same_kind(&old, &new) => {
                    self.move_tree(&old, &new, registry, batch)
                }
                _ => self.remove_at(&old, batch),
            }
        }
    }

    /// 整棵子树对账：扫描 dir，新增或变化的 upsert，已知但没扫到的移除。
    /// 注意：scan 静默跳过读不了的目录和文件，这里无法区分“读不了”和“已删除”，
    /// 两者都会被当作移除。会话取消时扫描提前结束，什么也不做。
    fn rescan(&mut self, dir: &Path, recursive: bool, registry: &Registry, batch: &mut Batch) {
        let mut found = Vec::new();
        scan(dir, recursive, &self.cancel, &mut |b| found.extend(b));
        if self.cancelled() {
            return;
        }
        let mut seen = HashSet::new();
        for item in found {
            let stamp = Stamp {
                size: item.size,
                mtime_ms: item.mtime_ms,
            };
            self.saw_image(&item.path, stamp, registry, batch);
            seen.insert(item.path);
        }
        for k in self.known_under(dir) {
            if !seen.contains(&k) {
                self.remove(&k, batch);
            }
        }
    }

    /// 磁盘上有这张图：未知则登记并 upsert，已知且版本变了则 upsert。
    fn saw_image(&mut self, p: &Path, stamp: Stamp, registry: &Registry, batch: &mut Batch) {
        match self.known.get_mut(p) {
            Some((_, old)) if *old == stamp => {}
            Some((id, old)) => {
                *old = stamp;
                batch.upsert(*id, true, p, stamp);
            }
            None => {
                let id = registry.register(p).0;
                self.known.insert(p.to_path_buf(), (id, stamp));
                batch.upsert(id, false, p, stamp);
            }
        }
    }

    fn renamed(&mut self, from: &Path, to: &Path, registry: &Registry, batch: &mut Batch) {
        let to_meta = std::fs::symlink_metadata(to).ok();
        let from_id = self.known.get(from).map(|&(id, _)| id);
        let from_known_before = from_id.is_some_and(|id| !batch.is_fresh(id));
        if !from_known_before && from != to && self.known.contains_key(to) {
            // 原子保存：临时文件（未知，或本批才登记的）改名覆盖已知文件，
            // 是 to 那个 id 的内容变化；临时文件本批的登记作废
            if from_id.is_some() {
                self.remove(from, batch);
            }
            self.touched(to, registry, batch);
            return;
        }
        if from_id.is_some() {
            // 已知文件（含本批才登记的）改名：迁移 id；覆盖已知目标的情况只会是
            // from 在本批之前就已知，见上一分支
            let to_ok = self.in_scope(to)
                && is_image_path(to)
                && to_meta.as_ref().is_some_and(|m| m.is_file());
            if to_ok && from != to && self.move_known(from, to, registry, batch) {
                self.touched(to, registry, batch);
                return;
            }
        } else {
            if self.is_known(from) && to_meta.as_ref().is_some_and(|m| m.is_dir()) {
                if self.in_scope(to) {
                    self.move_tree(from, to, registry, batch);
                } else {
                    self.remove_at(from, batch);
                }
                return;
            }
        }
        self.touched(from, registry, batch);
        self.touched(to, registry, batch);
    }

    /// 把已知文件 from 迁到 to，id 不变；to 原本已知（被覆盖）时先移除它。
    /// registry 里没有 from 时返回 false，什么也不做。
    fn move_known(
        &mut self,
        from: &Path,
        to: &Path,
        registry: &Registry,
        batch: &mut Batch,
    ) -> bool {
        let Some(&(id, stamp)) = self.known.get(from) else {
            return false;
        };
        if registry.path(FileId(id)).as_deref() != Some(from) {
            return false;
        }
        self.remove(to, batch);
        registry.rename(from, to);
        self.known.remove(from);
        self.known.insert(to.to_path_buf(), (id, stamp));
        batch.renamed(id, to);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::scan::stamp_of;
    use std::fs;
    use std::path::Path;

    fn write(root: &Path, rel: &str, len: usize) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; len]).unwrap();
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        registry: Registry,
        cancel: Arc<AtomicBool>,
        reconciler: Reconciler,
    }

    impl Fixture {
        /// 在临时目录下建好 files（每个 1 字节），全部登记为已知。
        fn new(files: &[&str], recursive: bool) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("root");
            fs::create_dir_all(&root).unwrap();
            let registry = Registry::default();
            let mut known = HashMap::new();
            for rel in files {
                write(&root, rel, 1);
                let p = root.join(rel);
                let id = registry.register(&p).0;
                known.insert(p.clone(), (id, stamp_of(&p).unwrap()));
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let reconciler = Reconciler::new(root.clone(), recursive, known, cancel.clone());
            Fixture {
                _dir: dir,
                root,
                registry,
                cancel,
                reconciler,
            }
        }

        fn p(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn id(&self, rel: &str) -> u32 {
            self.registry.register(&self.p(rel)).0
        }

        fn touch(&mut self, rel: &str) -> Changes {
            let hint = FsHint::Touched(self.p(rel));
            self.reconciler.apply(&[hint], &self.registry)
        }

        fn renamed(&mut self, from: &str, to: &str) -> Changes {
            let hint = FsHint::Renamed {
                from: self.p(from),
                to: self.p(to),
            };
            self.reconciler.apply(&[hint], &self.registry)
        }
    }

    fn rels(changes: &Changes) -> Vec<String> {
        let mut v: Vec<_> = changes.upserts.iter().map(|e| e.rel_path.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn new_image_is_added() {
        let mut f = Fixture::new(&[], true);
        write(&f.root, "a.png", 3);
        let c = f.touch("a.png");
        assert_eq!(c.upserts.len(), 1);
        let e = &c.upserts[0];
        assert_eq!(e.rel_path, "a.png");
        assert_eq!(e.size, 3);
        assert_eq!(e.id, f.id("a.png"));
        assert_eq!(c.upsert_paths, vec![(e.id, f.p("a.png"))]);
        assert!(c.removed.is_empty() && c.renamed.is_empty());
        // 再来一次同样的提示：已经知道了，无事发生
        assert!(f.touch("a.png").is_empty());
    }

    #[test]
    fn rewritten_image_keeps_its_id() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        write(&f.root, "a.png", 10);
        let c = f.touch("a.png");
        assert_eq!(c.upserts.len(), 1);
        assert_eq!(c.upserts[0].id, id);
        assert_eq!(c.upserts[0].size, 10);
        assert!(c.removed.is_empty());
    }

    #[test]
    fn untouched_image_yields_nothing() {
        let mut f = Fixture::new(&["a.png"], true);
        assert!(f.touch("a.png").is_empty());
    }

    #[test]
    fn deleted_image_is_removed() {
        let mut f = Fixture::new(&["a.png", "b.png"], true);
        let id = f.id("a.png");
        fs::remove_file(f.p("a.png")).unwrap();
        let c = f.touch("a.png");
        assert_eq!(c.removed, vec![id]);
        assert!(c.upserts.is_empty() && c.renamed.is_empty());
        assert!(f.touch("a.png").is_empty());
    }

    #[test]
    fn deleted_directory_removes_everything_under_it() {
        let mut f = Fixture::new(&["sub/a.png", "sub/deep/b.png", "sub2/x.png"], true);
        let mut want = vec![f.id("sub/a.png"), f.id("sub/deep/b.png")];
        want.sort();
        fs::remove_dir_all(f.p("sub")).unwrap();
        let mut c = f.touch("sub");
        c.removed.sort();
        assert_eq!(c.removed, want);
        assert!(!c.removed.contains(&f.id("sub2/x.png")));
    }

    #[test]
    fn new_directory_is_scanned_when_recursive() {
        let mut f = Fixture::new(&["a.png"], true);
        let outside = f.root.parent().unwrap().join("incoming");
        write(&outside, "x.png", 1);
        write(&outside, "deep/y.jpg", 1);
        write(&outside, ".hidden/z.png", 1);
        write(&outside, "notes.txt", 1);
        fs::rename(&outside, f.p("new")).unwrap();
        let c = f.touch("new");
        assert_eq!(rels(&c), vec!["new/deep/y.jpg", "new/x.png"]);
        assert!(c.removed.is_empty() && c.renamed.is_empty());
    }

    #[test]
    fn new_directory_is_ignored_when_not_recursive() {
        let mut f = Fixture::new(&["a.png"], false);
        write(&f.root, "new/x.png", 1);
        assert!(f.touch("new").is_empty());
    }

    #[test]
    fn nested_file_is_ignored_when_not_recursive() {
        let mut f = Fixture::new(&["a.png"], false);
        write(&f.root, "sub/x.png", 1);
        assert!(f.touch("sub/x.png").is_empty());
        // 直接下级照常
        write(&f.root, "b.png", 1);
        assert_eq!(rels(&f.touch("b.png")), vec!["b.png"]);
    }

    #[test]
    fn skipped_names_are_ignored() {
        let mut f = Fixture::new(&[], true);
        for rel in [".hidden/a.png", "node_modules/a.png", ".a.png"] {
            write(&f.root, rel, 1);
            assert!(f.touch(rel).is_empty(), "{rel}");
        }
        assert!(f.touch(".hidden").is_empty());
        assert!(f.touch("node_modules").is_empty());
    }

    #[test]
    fn non_image_is_ignored() {
        let mut f = Fixture::new(&[], true);
        write(&f.root, "notes.txt", 1);
        assert!(f.touch("notes.txt").is_empty());
    }

    #[test]
    fn rename_keeps_the_id() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        let c = f.renamed("a.png", "b.png");
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id,
                rel_path: "b.png".into()
            }]
        );
        assert!(c.removed.is_empty() && c.upserts.is_empty());
        assert_eq!(f.registry.path(FileId(id)), Some(f.p("b.png")));
        // known 已迁移：新路径无变化，旧路径不再已知
        assert!(f.touch("b.png").is_empty());
        assert!(f.touch("a.png").is_empty());
    }

    #[test]
    fn rename_over_an_existing_image_removes_the_target() {
        let mut f = Fixture::new(&["a.png", "b.png"], true);
        let a = f.id("a.png");
        let b = f.id("b.png");
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        let c = f.renamed("a.png", "b.png");
        assert_eq!(c.removed, vec![b]);
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id: a,
                rel_path: "b.png".into()
            }]
        );
        assert!(c.upserts.is_empty());
        assert_eq!(f.registry.path(FileId(a)), Some(f.p("b.png")));
    }

    #[test]
    fn rename_then_content_change_reports_both() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        write(&f.root, "b.png", 7);
        let c = f.renamed("a.png", "b.png");
        assert_eq!(c.renamed.len(), 1);
        assert_eq!(c.upserts.len(), 1);
        assert_eq!(c.upserts[0].id, id);
        assert_eq!(c.upserts[0].rel_path, "b.png");
        assert_eq!(c.upserts[0].size, 7);
    }

    #[test]
    fn rename_to_a_non_image_extension_removes_it() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("a.txt")).unwrap();
        let c = f.renamed("a.png", "a.txt");
        assert_eq!(c.removed, vec![id]);
        assert!(c.renamed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn atomic_save_is_a_content_change() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        write(&f.root, "tmp123", 20);
        fs::rename(f.p("tmp123"), f.p("a.png")).unwrap();
        let c = f.renamed("tmp123", "a.png");
        assert_eq!(c.upserts.len(), 1);
        assert_eq!(c.upserts[0].id, id);
        assert_eq!(c.upserts[0].size, 20);
        assert!(c.removed.is_empty() && c.renamed.is_empty());
    }

    #[test]
    fn directory_rename_keeps_ids() {
        let mut f = Fixture::new(&["sub/a.png", "sub/deep/b.png", "other.png"], true);
        let a = f.id("sub/a.png");
        let b = f.id("sub/deep/b.png");
        fs::rename(f.p("sub"), f.p("sub2")).unwrap();
        let c = f.renamed("sub", "sub2");
        let mut got: Vec<_> = c
            .renamed
            .iter()
            .map(|r| (r.id, r.rel_path.clone()))
            .collect();
        got.sort();
        let mut want = vec![
            (a, "sub2/a.png".to_string()),
            (b, "sub2/deep/b.png".to_string()),
        ];
        want.sort();
        assert_eq!(got, want);
        assert!(c.removed.is_empty() && c.upserts.is_empty());
        assert_eq!(f.registry.path(FileId(b)), Some(f.p("sub2/deep/b.png")));
    }

    #[test]
    fn directory_renamed_into_a_skipped_name_is_removed() {
        let mut f = Fixture::new(&["sub/a.png", "sub/b.png"], true);
        let mut want = vec![f.id("sub/a.png"), f.id("sub/b.png")];
        want.sort();
        fs::rename(f.p("sub"), f.p(".sub")).unwrap();
        let mut c = f.renamed("sub", ".sub");
        c.removed.sort();
        assert_eq!(c.removed, want);
        assert!(c.renamed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn results_for_one_id_are_merged_within_a_batch() {
        let mut f = Fixture::new(&["a.png", "b.png"], true);
        let a = f.id("a.png");
        let b = f.id("b.png");
        write(&f.root, "a.png", 5);
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        // 先到的 Touched(b) 会把 b 看成内容变化，随后的改名又把 b 原来的 id 移除：
        // 合并后 b 只出现在 removed 里；a 改名且内容变了，两处都有
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(f.p("b.png")),
                FsHint::Renamed {
                    from: f.p("a.png"),
                    to: f.p("b.png"),
                },
                FsHint::Touched(f.p("b.png")),
            ],
            &f.registry,
        );
        assert_eq!(c.removed, vec![b]);
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id: a,
                rel_path: "b.png".into()
            }]
        );
        assert_eq!(c.upserts.len(), 1);
        assert_eq!(c.upserts[0].id, a);
        assert_eq!(c.upserts[0].rel_path, "b.png");
        assert_eq!(c.upsert_paths, vec![(a, f.p("b.png"))]);
    }

    #[test]
    fn touched_root_is_a_full_rescan() {
        let mut f = Fixture::new(&["gone.png", "same.png", "changed.png"], true);
        let gone = f.id("gone.png");
        let changed = f.id("changed.png");
        fs::remove_file(f.p("gone.png")).unwrap();
        write(&f.root, "changed.png", 9);
        write(&f.root, "sub/new.png", 1);
        let root = f.root.clone();
        let c = f.reconciler.apply(&[FsHint::Touched(root)], &f.registry);
        assert_eq!(c.removed, vec![gone]);
        assert!(c.renamed.is_empty());
        let mut got: Vec<_> = c
            .upserts
            .iter()
            .map(|e| (e.rel_path.clone(), e.id))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("changed.png".to_string(), changed),
                ("sub/new.png".to_string(), f.id("sub/new.png")),
            ]
        );
    }

    #[test]
    fn touched_directory_removes_files_that_vanished_under_it() {
        let mut f = Fixture::new(&["sub/a.png", "sub/b.png", "sub2/c.png"], true);
        let a = f.id("sub/a.png");
        fs::remove_file(f.p("sub/a.png")).unwrap();
        write(&f.root, "sub/d.png", 1);
        let c = f.touch("sub");
        assert_eq!(c.removed, vec![a]);
        assert_eq!(rels(&c), vec!["sub/d.png"]);
        assert!(c.renamed.is_empty());
    }

    #[test]
    fn touched_root_when_not_recursive_only_sees_the_top_level() {
        let mut f = Fixture::new(&["a.png", "b.png"], false);
        let b = f.id("b.png");
        fs::remove_file(f.p("b.png")).unwrap();
        write(&f.root, "c.png", 1);
        write(&f.root, "sub/x.png", 1);
        let root = f.root.clone();
        let c = f.reconciler.apply(&[FsHint::Touched(root)], &f.registry);
        assert_eq!(c.removed, vec![b]);
        assert_eq!(rels(&c), vec!["c.png"]);
        // 非递归时子目录本身仍被忽略
        assert!(f.touch("sub").is_empty());
    }

    #[test]
    fn known_path_that_is_now_skipped_is_removed() {
        // known 里混进了被跳过位置的条目（例如 Windows 上目录刚被设为隐藏）
        let mut f = Fixture::new(&[".hidden/a.png", ".hidden/b.png", ".c.png"], true);
        let c_id = f.id(".c.png");
        let mut want = vec![f.id(".hidden/a.png"), f.id(".hidden/b.png")];
        want.sort();
        assert_eq!(f.touch(".c.png").removed, vec![c_id]);
        let mut c = f.touch(".hidden");
        c.removed.sort();
        assert_eq!(c.removed, want);
        assert!(c.upserts.is_empty() && c.renamed.is_empty());
    }

    #[test]
    fn atomic_save_via_image_named_temp_keeps_the_id() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        // 编辑器用图片扩展名的临时文件保存，监听层先报临时文件出现，再报改名覆盖
        write(&f.root, "tmp.png", 20);
        fs::rename(f.p("tmp.png"), f.p("a.png")).unwrap();
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(f.p("tmp.png")),
                FsHint::Renamed {
                    from: f.p("tmp.png"),
                    to: f.p("a.png"),
                },
                FsHint::Touched(f.p("a.png")),
            ],
            &f.registry,
        );
        assert_eq!(c.upserts.len(), 1, "{c:?}");
        assert_eq!(c.upserts[0].id, id);
        assert_eq!(c.upserts[0].rel_path, "a.png");
        assert_eq!(c.upserts[0].size, 20);
        assert!(c.removed.is_empty() && c.renamed.is_empty());
        assert_eq!(f.registry.path(FileId(id)), Some(f.p("a.png")));
    }

    #[test]
    fn new_file_renamed_in_the_same_batch_is_one_upsert() {
        let mut f = Fixture::new(&[], true);
        write(&f.root, "x.png", 4);
        fs::rename(f.p("x.png"), f.p("y.png")).unwrap();
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(f.p("x.png")),
                FsHint::Renamed {
                    from: f.p("x.png"),
                    to: f.p("y.png"),
                },
            ],
            &f.registry,
        );
        // 前端没见过 x：只出一条新增，不出 renamed / removed，也不给 x 白白登记 id
        assert_eq!(c.upserts.len(), 1, "{c:?}");
        assert_eq!(c.upserts[0].id, 1);
        assert_eq!(c.upserts[0].rel_path, "y.png");
        assert_eq!(c.upsert_paths, vec![(1, f.p("y.png"))]);
        assert!(c.removed.is_empty() && c.renamed.is_empty());
    }

    #[test]
    fn rename_is_honoured_when_its_directory_was_touched_first() {
        let mut f = Fixture::new(&["sub/a.png"], true);
        let id = f.id("sub/a.png");
        fs::rename(f.p("sub/a.png"), f.p("sub/b.png")).unwrap();
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(f.p("sub")),
                FsHint::Renamed {
                    from: f.p("sub/a.png"),
                    to: f.p("sub/b.png"),
                },
            ],
            &f.registry,
        );
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id,
                rel_path: "sub/b.png".into()
            }],
            "{c:?}"
        );
        assert!(c.removed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn rename_is_honoured_when_its_source_was_touched_first() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(f.p("a.png")),
                FsHint::Renamed {
                    from: f.p("a.png"),
                    to: f.p("b.png"),
                },
                FsHint::Touched(f.p("b.png")),
            ],
            &f.registry,
        );
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id,
                rel_path: "b.png".into()
            }],
            "{c:?}"
        );
        assert!(c.removed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn known_under_is_exactly_the_subtree() {
        let f = Fixture::new(
            &[
                "sub/a.png",
                "sub/deep/b.png",
                "sub2/c.png",
                "sub.png",
                "su/d.png",
                "a.png",
            ],
            true,
        );
        assert_eq!(
            f.reconciler.known_under(&f.p("sub")),
            vec![f.p("sub/a.png"), f.p("sub/deep/b.png")]
        );
        assert!(f.reconciler.known_under(&f.p("sub.png")).is_empty());
        assert_eq!(f.reconciler.known_under(&f.root).len(), 6);
    }

    #[test]
    fn known_file_moved_out_of_root_is_removed() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        let outside = f.root.parent().unwrap().join("a.png");
        fs::rename(f.p("a.png"), &outside).unwrap();
        let c = f.reconciler.apply(
            &[FsHint::Renamed {
                from: f.p("a.png"),
                to: outside,
            }],
            &f.registry,
        );
        assert_eq!(c.removed, vec![id]);
        assert!(c.renamed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn directory_moved_out_of_root_is_removed() {
        let mut f = Fixture::new(&["sub/a.png", "sub/deep/b.png", "c.png"], true);
        let mut want = vec![f.id("sub/a.png"), f.id("sub/deep/b.png")];
        want.sort();
        let outside = f.root.parent().unwrap().join("sub");
        fs::rename(f.p("sub"), &outside).unwrap();
        let mut c = f.reconciler.apply(
            &[FsHint::Renamed {
                from: f.p("sub"),
                to: outside,
            }],
            &f.registry,
        );
        c.removed.sort();
        assert_eq!(c.removed, want);
        assert!(c.renamed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn deleted_image_is_removed_when_not_recursive() {
        let mut f = Fixture::new(&["a.png", "b.png"], false);
        let id = f.id("a.png");
        fs::remove_file(f.p("a.png")).unwrap();
        let c = f.touch("a.png");
        assert_eq!(c.removed, vec![id]);
        assert!(c.upserts.is_empty() && c.renamed.is_empty());
    }

    #[test]
    fn hints_for_paths_outside_root_are_ignored() {
        let mut f = Fixture::new(&["a.png"], true);
        let other = f.root.parent().unwrap().join("other");
        write(&other, "x.png", 1);
        let c = f.reconciler.apply(
            &[
                FsHint::Touched(other.join("x.png")),
                FsHint::Touched(other.clone()),
            ],
            &f.registry,
        );
        assert!(c.is_empty());
    }

    #[test]
    fn listed_directory_drops_known_children_that_vanished() {
        let mut f = Fixture::new(&["a.png", "b.png", "sub/c.png", "sub/deep/d.png", "gone/e.png"], true);
        let (b, e) = (f.id("b.png"), f.id("gone/e.png"));
        fs::remove_file(f.p("b.png")).unwrap();
        fs::remove_file(f.p("sub/deep/d.png")).unwrap();
        fs::remove_dir_all(f.p("gone")).unwrap();
        write(&f.root, "new.png", 1);
        let root = f.root.clone();
        let c = f.reconciler.apply(&[FsHint::Listed(root)], &f.registry);
        // 只看直接下级是否还在：b.png 与 gone/ 消失；sub/ 还在，其下不深究；不新增
        let mut removed = c.removed.clone();
        removed.sort();
        assert_eq!(removed, vec![b, e]);
        assert!(c.renamed.is_empty() && c.upserts.is_empty());
        // 子目录同理
        let sub = f.p("sub");
        let d = f.id("sub/deep/d.png");
        fs::remove_dir_all(f.p("sub/deep")).unwrap();
        let c = f.reconciler.apply(&[FsHint::Listed(sub)], &f.registry);
        assert_eq!(c.removed, vec![d]);
    }

    #[test]
    fn listed_directory_outside_scope_or_missing_is_ignored() {
        let mut f = Fixture::new(&["a.png", "sub/b.png"], false);
        let other = f.root.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        let (sub, missing) = (f.p("sub"), f.p("missing"));
        let c = f.reconciler.apply(
            &[FsHint::Listed(other), FsHint::Listed(sub), FsHint::Listed(missing)],
            &f.registry,
        );
        assert!(c.is_empty());
    }

    #[test]
    fn listed_runs_after_renames() {
        // Listed 排在前面也不会抢先把改名的源当作消失
        let mut f = Fixture::new(&["a.png"], true);
        let a = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("c.png")).unwrap();
        let root = f.root.clone();
        let c = f.reconciler.apply(
            &[
                FsHint::Listed(root),
                FsHint::Renamed { from: f.p("a.png"), to: f.p("c.png") },
            ],
            &f.registry,
        );
        assert_eq!(c.renamed, vec![RenamedItem { id: a, rel_path: "c.png".into() }]);
        assert!(c.removed.is_empty() && c.upserts.is_empty());
    }

    // 文件操作之后会立即投递提示，约 300 ms 后监听器再把同一变化报一遍：第二遍不应产生任何结果
    fn repeat(f: &mut Fixture, mut all: Vec<FsHint>) -> Changes {
        all.push(FsHint::Listed(f.root.clone()));
        f.reconciler.apply(&all, &f.registry)
    }

    #[test]
    fn repeating_an_applied_rename_yields_nothing() {
        let mut f = Fixture::new(&["a.png"], true);
        let id = f.id("a.png");
        fs::rename(f.p("a.png"), f.p("b.png")).unwrap();
        assert_eq!(f.renamed("a.png", "b.png").renamed.len(), 1);
        let hints = vec![
            FsHint::Renamed { from: f.p("a.png"), to: f.p("b.png") },
            FsHint::Touched(f.p("a.png")),
            FsHint::Touched(f.p("b.png")),
        ];
        let again = repeat(&mut f, hints);
        assert!(again.is_empty(), "{again:?}");
        assert_eq!(f.registry.path(FileId(id)), Some(f.p("b.png")));
    }

    #[test]
    fn repeating_an_applied_removal_yields_nothing() {
        let mut f = Fixture::new(&["a.png", "b.png"], true);
        let id = f.id("a.png");
        fs::remove_file(f.p("a.png")).unwrap();
        assert_eq!(f.touch("a.png").removed, vec![id]);
        let hints = vec![FsHint::Touched(f.p("a.png"))];
        let again = repeat(&mut f, hints);
        assert!(again.is_empty(), "{again:?}");
    }

    #[test]
    fn repeating_an_applied_creation_yields_nothing() {
        let mut f = Fixture::new(&["a.png"], true);
        write(&f.root, "new.png", 5);
        assert_eq!(rels(&f.touch("new.png")), vec!["new.png"]);
        let hints = vec![FsHint::Touched(f.p("new.png"))];
        let again = repeat(&mut f, hints);
        assert!(again.is_empty(), "{again:?}");
    }

    /// 临时目录所在的卷不区分大小写（macOS 默认的 APFS、Windows 的 NTFS）。
    fn case_insensitive_volume() -> bool {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a"), b"").unwrap();
        dir.path().join("A").exists()
    }

    #[test]
    fn case_only_rename_keeps_the_id() {
        if !case_insensitive_volume() {
            eprintln!("临时目录区分大小写，跳过");
            return;
        }
        // 监听层不给两半配对，两半各成一条 Touched，先后顺序不定；旧写法在不区分
        // 大小写的卷上仍能 stat 成功
        for old_first in [true, false] {
            let mut f = Fixture::new(&["Case.png", "other.png"], true);
            let id = f.id("Case.png");
            fs::rename(f.p("Case.png"), f.p("case.png")).unwrap();
            let (old, new) = (FsHint::Touched(f.p("Case.png")), FsHint::Touched(f.p("case.png")));
            let mut hints = if old_first { vec![old, new] } else { vec![new, old] };
            hints.push(FsHint::Listed(f.root.clone()));
            let c = f.reconciler.apply(&hints, &f.registry);
            assert_eq!(
                c.renamed,
                vec![RenamedItem {
                    id,
                    rel_path: "case.png".into()
                }],
                "old_first={old_first} {c:?}"
            );
            assert!(c.removed.is_empty() && c.upserts.is_empty(), "{c:?}");
            assert_eq!(f.registry.path(FileId(id)), Some(f.p("case.png")));
            // 之后两种写法的提示都不再有变化
            assert!(f.touch("case.png").is_empty());
            assert!(f.touch("Case.png").is_empty());
        }
    }

    #[test]
    fn case_only_rename_with_only_the_listing_keeps_the_id() {
        if !case_insensitive_volume() {
            eprintln!("临时目录区分大小写，跳过");
            return;
        }
        // 只剩旧写法那一半加上父目录的 Listed
        let mut f = Fixture::new(&["Case.png"], true);
        let id = f.id("Case.png");
        fs::rename(f.p("Case.png"), f.p("case.png")).unwrap();
        let c = f.reconciler.apply(
            &[FsHint::Touched(f.p("Case.png")), FsHint::Listed(f.root.clone())],
            &f.registry,
        );
        assert_eq!(
            c.renamed,
            vec![RenamedItem {
                id,
                rel_path: "case.png".into()
            }],
            "{c:?}"
        );
        assert!(c.removed.is_empty() && c.upserts.is_empty());
    }

    #[test]
    fn case_only_directory_rename_keeps_ids() {
        if !case_insensitive_volume() {
            eprintln!("临时目录区分大小写，跳过");
            return;
        }
        for old_first in [true, false] {
            let mut f = Fixture::new(&["Sub/a.png", "Sub/deep/b.png", "c.png"], true);
            let (a, b) = (f.id("Sub/a.png"), f.id("Sub/deep/b.png"));
            fs::rename(f.p("Sub"), f.p("sub")).unwrap();
            let (old, new) = (FsHint::Touched(f.p("Sub")), FsHint::Touched(f.p("sub")));
            let mut hints = if old_first { vec![old, new] } else { vec![new, old] };
            hints.push(FsHint::Listed(f.root.clone()));
            let c = f.reconciler.apply(&hints, &f.registry);
            let mut got: Vec<_> = c.renamed.iter().map(|r| (r.id, r.rel_path.clone())).collect();
            got.sort();
            let mut want = vec![(a, "sub/a.png".to_string()), (b, "sub/deep/b.png".to_string())];
            want.sort();
            assert_eq!(got, want, "old_first={old_first} {c:?}");
            assert!(c.removed.is_empty() && c.upserts.is_empty(), "{c:?}");
            assert_eq!(f.registry.path(FileId(b)), Some(f.p("sub/deep/b.png")));
            assert!(f.touch("sub").is_empty());
            assert!(f.touch("Sub").is_empty());
        }
    }

    #[test]
    fn cancelled_rescan_removes_nothing() {
        let mut f = Fixture::new(&["a.png", "sub/b.png", "sub/c.png"], true);
        fs::remove_file(f.p("a.png")).unwrap();
        // 会话已取消：子树扫描提前结束，没扫到的不能当作已删除
        f.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        let (root, sub) = (f.root.clone(), f.p("sub"));
        let c = f
            .reconciler
            .apply(&[FsHint::Touched(sub), FsHint::Touched(root)], &f.registry);
        assert!(c.removed.is_empty(), "{c:?}");
    }

    #[test]
    fn rel_paths_use_forward_slashes() {
        let mut f = Fixture::new(&[], true);
        write(&f.root, "sub/deep/a.png", 1);
        let c = f.touch("sub/deep/a.png");
        assert_eq!(rels(&c), vec!["sub/deep/a.png"]);
    }
}
