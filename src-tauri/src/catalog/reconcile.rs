//! 目录监听的比对：拿到“可能变了”的路径提示后，查看磁盘现状并与已知状态比对，
//! 得出新增、移除、改名与内容变化。只看磁盘、不信事件本身，所以重复的提示是幂等的。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::events::{Entry, RenamedItem};
use super::registry::{FileId, Registry};
use super::scan::{Stamp, is_image_path, is_skipped_path, scan, stamp_of};
use super::session::rel_path;

/// 监听层给出的路径提示。
#[derive(Debug, Clone, PartialEq)]
pub enum FsHint {
    Touched(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
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
    known: HashMap<PathBuf, (u32, Stamp)>,
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

/// 按 id 合并一批里的结果，保持首次出现的顺序。
#[derive(Default)]
struct Batch {
    order: Vec<u32>,
    outcomes: HashMap<u32, Outcome>,
}

impl Batch {
    fn outcome(&mut self, id: u32, was_known: bool) -> &mut Outcome {
        if !self.outcomes.contains_key(&id) {
            self.order.push(id);
        }
        self.outcomes.entry(id).or_insert_with(|| Outcome {
            was_known,
            ..Outcome::default()
        })
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
    pub fn new(root: PathBuf, recursive: bool, known: HashMap<PathBuf, (u32, Stamp)>) -> Self {
        Self {
            root,
            recursive,
            known,
        }
    }

    /// 按顺序处理提示，查看磁盘现状并更新 known。同一批里对同一 id 的结果合并：
    /// 最终只出现在 removed、renamed、upserts 之一（renamed 之后内容又变的，两处都出现）。
    pub fn apply(&mut self, hints: &[FsHint], registry: &Registry) -> Changes {
        let mut batch = Batch::default();
        for hint in hints {
            match hint {
                FsHint::Touched(p) => self.touched(p, registry, &mut batch),
                FsHint::Renamed { from, to } => self.renamed(from, to, registry, &mut batch),
            }
        }
        batch.finish(&self.root)
    }

    /// 在监听范围内：root 之下（不含 root 自身）、未被跳过、非递归时是 root 的直接下级。
    fn in_scope(&self, p: &Path) -> bool {
        match p.strip_prefix(&self.root) {
            Ok(rel) if rel.as_os_str().is_empty() => false,
            Ok(_) => {
                (self.recursive || p.parent() == Some(self.root.as_path()))
                    && !is_skipped_path(&self.root, p)
            }
            Err(_) => false,
        }
    }

    /// known 里位于目录 dir 之下的条目，按路径排序以保证输出稳定。
    fn known_under(&self, dir: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self
            .known
            .keys()
            .filter(|k| k.as_path() != dir && k.starts_with(dir))
            .cloned()
            .collect();
        v.sort();
        v
    }

    fn remove(&mut self, p: &Path, batch: &mut Batch) {
        if let Some((id, _)) = self.known.remove(p) {
            batch.removed(id);
        }
    }

    fn touched(&mut self, p: &Path, registry: &Registry, batch: &mut Batch) {
        if !self.in_scope(p) {
            return;
        }
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            // 不存在：已知文件被删，或整个目录被删
            if self.known.contains_key(p) {
                self.remove(p, batch);
            } else {
                for k in self.known_under(p) {
                    self.remove(&k, batch);
                }
            }
            return;
        };
        if meta.is_file() && is_image_path(p) {
            match stamp_of(p) {
                Some(stamp) => self.saw_image(p, stamp, registry, batch),
                None => self.remove(p, batch),
            }
        } else if meta.is_dir() {
            if self.recursive {
                let mut found = Vec::new();
                scan(p, true, &AtomicBool::new(false), &mut |b| found.extend(b));
                for item in found {
                    let stamp = Stamp {
                        size: item.size,
                        mtime_ms: item.mtime_ms,
                    };
                    self.saw_image(&item.path, stamp, registry, batch);
                }
            }
        } else {
            // 存在但不是图片文件（仅防御，改扩展名走改名分支）
            self.remove(p, batch);
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
        if self.known.contains_key(from) {
            let to_ok = self.in_scope(to)
                && is_image_path(to)
                && to_meta.as_ref().is_some_and(|m| m.is_file());
            if to_ok && from != to && self.move_known(from, to, registry, batch) {
                self.touched(to, registry, batch);
                return;
            }
        } else if self.known.contains_key(to) {
            // 原子保存：临时文件改名覆盖已知文件，是同一 id 的内容变化
            self.touched(to, registry, batch);
            return;
        } else {
            let under = self.known_under(from);
            if !under.is_empty() && to_meta.as_ref().is_some_and(|m| m.is_dir()) {
                let to_ok = self.in_scope(to);
                for old in under {
                    if to_ok {
                        let new = to.join(old.strip_prefix(from).unwrap_or(&old));
                        if self.move_known(&old, &new, registry, batch) {
                            continue;
                        }
                    }
                    self.remove(&old, batch);
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
            let reconciler = Reconciler::new(root.clone(), recursive, known);
            Fixture {
                _dir: dir,
                root,
                registry,
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
    fn rel_paths_use_forward_slashes() {
        let mut f = Fixture::new(&[], true);
        write(&f.root, "sub/deep/a.png", 1);
        let c = f.touch("sub/deep/a.png");
        assert_eq!(rels(&c), vec!["sub/deep/a.png"]);
    }
}
