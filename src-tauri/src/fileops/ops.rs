//! 删除、重命名、移动、复制四种操作，以及按撤销步骤还原。都直接作用于路径。
//! 删除、重命名和同卷移动把符号链接当作链接本身处理；复制和跨卷移动会跟随它，
//! 得到的是链接所指文件的一份普通副本。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use super::fsx::{self, FsError};
use super::trash;
use super::undo::{OpKind, Step};
use crate::catalog::reconcile::FsHint;

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    Skip,
    KeepBoth,
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// 与输入一一对应：成功给出文件现在的路径（删除则为原路径）。
    pub items: Vec<Result<PathBuf, FsError>>,
    pub steps: Vec<Step>,   // 只含成功项的逆操作
    pub hints: Vec<FsHint>, // 只含成功项：改名 / 移动 → Renamed{from,to}；删除 → Touched(from)；复制 → Touched(to)
}

pub fn trash(paths: &[PathBuf]) -> Outcome {
    let mut out = Outcome::default();
    for path in paths {
        match trash::move_to_trash(path) {
            Ok(handle) => {
                out.steps.push(Step::Restore(handle));
                out.hints.push(FsHint::Touched(path.clone()));
                out.items.push(Ok(path.clone()));
            }
            Err(err) => out.items.push(Err(FsError::from(err))),
        }
    }
    out
}

/// 名字不合法 → InvalidName；与原名相同 → 成功且无步骤无提示。只改最后一级名字。
pub fn rename(path: &Path, new_name: &str) -> Outcome {
    let mut out = Outcome::default();
    let result = rename_one(path, new_name);
    if let Ok(to) = &result
        && to != path
    {
        out.steps.push(Step::MoveBack {
            from: to.clone(),
            to: path.to_path_buf(),
        });
        out.hints.push(FsHint::Renamed {
            from: path.to_path_buf(),
            to: to.clone(),
        });
    }
    out.items.push(result);
    out
}

fn rename_one(path: &Path, new_name: &str) -> Result<PathBuf, FsError> {
    // 先校验：名字里不许有分隔符，于是只会改最后一级。
    fsx::validate_name(new_name)?;
    let to = path.with_file_name(new_name);
    if to == path {
        return Ok(to);
    }
    fsx::rename_noreplace(path, &to)?;
    Ok(to)
}

/// 把 paths 移动或复制到 dest_dir（kind 只能是 Move 或 Copy）。
/// 目标目录不存在 → 全部 NotFound；移动到自己所在的目录 → 该项成功、无步骤无提示；
/// 复制到自己所在的目录按重名处理。KeepBoth 遇到重名时依次试 "名字 (2)" 到 "名字 (999)"。
pub fn transfer(kind: OpKind, paths: &[PathBuf], dest_dir: &Path, conflict: Conflict) -> Outcome {
    debug_assert!(matches!(kind, OpKind::Move | OpKind::Copy));
    let mut out = Outcome::default();
    if !fs::metadata(dest_dir).is_ok_and(|m| m.is_dir()) {
        out.items = paths.iter().map(|_| Err(FsError::NotFound)).collect();
        return out;
    }
    for from in paths {
        if kind == OpKind::Move && from.parent().is_some_and(|p| same_dir(p, dest_dir)) {
            let here = from.symlink_metadata().map(|_| from.clone());
            out.items.push(here.map_err(|e| FsError::from(&e)));
            continue;
        }
        let result = transfer_one(kind, from, dest_dir, conflict);
        if let Ok(to) = &result {
            if kind == OpKind::Move {
                out.steps.push(Step::MoveBack {
                    from: to.clone(),
                    to: from.clone(),
                });
                out.hints.push(FsHint::Renamed {
                    from: from.clone(),
                    to: to.clone(),
                });
            } else {
                out.steps.push(Step::Trash(to.clone()));
                out.hints.push(FsHint::Touched(to.clone()));
            }
        }
        out.items.push(result);
    }
    out
}

fn transfer_one(
    kind: OpKind,
    from: &Path,
    dest_dir: &Path,
    conflict: Conflict,
) -> Result<PathBuf, FsError> {
    let name = from.file_name().ok_or(FsError::InvalidName)?;
    let target = dest_dir.join(name);
    let attempt = |to: &Path| match kind {
        OpKind::Copy => fsx::copy_noreplace(from, to),
        _ => fsx::move_noreplace(from, to),
    };
    match attempt(&target) {
        Err(FsError::Exists) if conflict == Conflict::KeepBoth => {
            for n in 2..=999 {
                let numbered = fsx::numbered(&target, n);
                match attempt(&numbered) {
                    Err(FsError::Exists) => continue,
                    result => return result.map(|()| numbered),
                }
            }
            Err(FsError::Exists)
        }
        result => result.map(|()| target),
    }
}

/// 两个路径是否指的是同一个目录（字面相同，或解析符号链接后相同）。
fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// 在 parent 下新建目录；已存在同名目录时直接用它（不算错，也不产生撤销步骤），
/// 返回它在磁盘上的写法（不分大小写的卷上输入 "Sub" 而已有 "sub" 时得到 "sub"）。
pub fn make_dir(parent: &Path, name: &str) -> Result<(PathBuf, Option<Step>), FsError> {
    fsx::validate_name(name)?;
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => Ok((path.clone(), Some(Step::RemoveEmptyDir(path)))),
        // 同名的是真目录才复用；文件或符号链接都算重名。
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            if path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                Ok((on_disk_spelling(parent, name).unwrap_or(path), None))
            } else {
                Err(FsError::Exists)
            }
        }
        Err(e) => Err(FsError::from(&e)),
    }
}

/// parent 里与 name 对应的条目的真实路径：先找完全相同的名字，否则找唯一一个只差大小写的；
/// 都没有（或读不了目录、有多个候选）时返回 None。
fn on_disk_spelling(parent: &Path, name: &str) -> Option<PathBuf> {
    let names: Vec<String> = fs::read_dir(parent)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    if names.iter().any(|n| n == name) {
        return Some(parent.join(name));
    }
    let lower = name.to_lowercase();
    let mut matches = names.iter().filter(|n| n.to_lowercase() == lower);
    match (matches.next(), matches.next()) {
        (Some(only), None) => Some(parent.join(only)),
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct UndoOutcome {
    pub done: usize,
    pub failed: Vec<(PathBuf, FsError)>,
    pub hints: Vec<FsHint>,
}

/// 按倒序执行全部步骤，单步失败不中断其余。
pub fn undo(steps: &[Step]) -> UndoOutcome {
    let mut out = UndoOutcome::default();
    for step in steps.iter().rev() {
        match undo_one(step) {
            Ok(hint) => {
                out.done += 1;
                out.hints.extend(hint);
            }
            Err(err) => out.failed.push((step_path(step).to_path_buf(), err)),
        }
    }
    out
}

fn undo_one(step: &Step) -> Result<Option<FsHint>, FsError> {
    match step {
        Step::Restore(handle) => {
            trash::restore(handle).map_err(trash::TrashError::into_restore_error)?;
            Ok(Some(FsHint::Touched(handle.original.clone())))
        }
        Step::MoveBack { from, to } => {
            fsx::move_noreplace(from, to)?;
            Ok(Some(FsHint::Renamed {
                from: from.clone(),
                to: to.clone(),
            }))
        }
        Step::Trash(path) => {
            trash::move_to_trash(path)?;
            Ok(Some(FsHint::Touched(path.clone())))
        }
        Step::RemoveEmptyDir(path) => match fs::remove_dir(path) {
            Ok(()) => Ok(None),
            // 目录里已有东西：跳过，不算失败。目录已经不在：目的已达到，也算完成。
            Err(e) if matches!(e.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::NotFound) => {
                Ok(None)
            }
            Err(e) => Err(FsError::from(&e)),
        },
    }
}

/// 失败时报告的路径：这一步针对的文件。
fn step_path(step: &Step) -> &Path {
    match step {
        Step::Restore(handle) => &handle.original,
        Step::MoveBack { from, .. } => from,
        Step::Trash(path) | Step::RemoveEmptyDir(path) => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// 目录树快照：相对路径 → 内容（目录为 None）。
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path.strip_prefix(root).unwrap().to_path_buf();
                if path.symlink_metadata().unwrap().is_dir() {
                    out.insert(rel, None);
                    walk(root, &path, out);
                } else {
                    out.insert(rel, Some(fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn write(path: &Path, content: &[u8]) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
        path.to_path_buf()
    }

    fn assert_no_failures(outcome: &UndoOutcome) {
        assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    }

    #[test]
    fn rename_then_undo_restores_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("a.png"), b"a");
        write(&dir.path().join("b.png"), b"b");
        let before = snapshot(dir.path());

        let out = rename(&a, "新名字.png");
        let renamed = dir.path().join("新名字.png");
        assert_eq!(out.items, vec![Ok(renamed.clone())]);
        assert_eq!(fs::read(&renamed).unwrap(), b"a");
        assert!(a.symlink_metadata().is_err());

        let undone = undo(&out.steps);
        assert_no_failures(&undone);
        assert_eq!(undone.done, 1);
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn rename_to_an_existing_name_fails_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("a.png"), b"a");
        write(&dir.path().join("b.png"), b"b");
        let before = snapshot(dir.path());

        let out = rename(&a, "b.png");
        assert_eq!(out.items, vec![Err(FsError::Exists)]);
        assert!(out.steps.is_empty());
        assert!(out.hints.is_empty());
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn rename_to_the_same_name_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("a.png"), b"a");

        let out = rename(&a, "a.png");
        assert_eq!(out.items, vec![Ok(a.clone())]);
        assert!(out.steps.is_empty());
        assert!(out.hints.is_empty());
        assert_eq!(fs::read(&a).unwrap(), b"a");
    }

    #[test]
    fn rename_changes_only_the_last_component() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("sub").join("a.png"), b"a");
        let before = snapshot(dir.path());

        for name in ["../a.png", "x/a.png", "x\\a.png", "..", ""] {
            let out = rename(&a, name);
            assert_eq!(out.items, vec![Err(FsError::InvalidName)], "{name:?}");
            assert!(out.steps.is_empty());
            assert!(out.hints.is_empty());
        }
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn move_then_undo_restores_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("src").join("a.png"), b"a");
        let b = write(&dir.path().join("src").join("deep").join("b.png"), b"b");
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let before = snapshot(dir.path());

        let out = transfer(OpKind::Move, &[a, b], &dest, Conflict::Skip);
        assert_eq!(
            out.items,
            vec![Ok(dest.join("a.png")), Ok(dest.join("b.png"))]
        );
        assert_eq!(fs::read(dest.join("b.png")).unwrap(), b"b");

        let undone = undo(&out.steps);
        assert_no_failures(&undone);
        assert_eq!(undone.done, 2);
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    #[ignore = "撤销会把副本移入真实废纸篓"]
    fn copy_then_undo_leaves_only_the_originals() {
        // 放在用户目录下：系统废纸篓不一定接受临时目录里的文件。
        let home = dirs::home_dir().expect("home dir");
        let dir = tempfile::Builder::new()
            .prefix(".glance-test-")
            .tempdir_in(home)
            .unwrap();
        let a = write(&dir.path().join("src").join("a.png"), b"a");
        let b = write(&dir.path().join("src").join("b.png"), b"b");
        let dest = dir.path().join("dest");
        write(&dest.join("a.png"), b"already here");
        let before = snapshot(dir.path());

        let out = transfer(OpKind::Copy, &[a.clone(), b], &dest, Conflict::KeepBoth);
        assert_eq!(
            out.items,
            vec![Ok(dest.join("a (2).png")), Ok(dest.join("b.png"))]
        );
        assert_eq!(fs::read(dest.join("a (2).png")).unwrap(), b"a");
        assert_eq!(fs::read(&a).unwrap(), b"a");

        let undone = undo(&out.steps);
        assert_no_failures(&undone);
        assert_eq!(undone.done, 2);
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn move_skips_conflicts_and_reports_them() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let dest = dir.path().join("dest");
        let a = write(&src.join("a.png"), b"a");
        let b = write(&src.join("b.png"), b"b new");
        let c = write(&src.join("c.png"), b"c");
        write(&dest.join("b.png"), b"b old");

        let out = transfer(OpKind::Move, &[a, b.clone(), c], &dest, Conflict::Skip);
        assert_eq!(
            out.items,
            vec![
                Ok(dest.join("a.png")),
                Err(FsError::Exists),
                Ok(dest.join("c.png"))
            ]
        );
        assert_eq!(out.steps.len(), 2);
        assert_eq!(fs::read(dest.join("b.png")).unwrap(), b"b old");
        assert_eq!(fs::read(&b).unwrap(), b"b new");
    }

    #[test]
    fn move_keep_both_numbers_the_newcomer() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        let a = write(&dir.path().join("src").join("a.png"), b"newcomer");
        write(&dest.join("a.png"), b"first");
        write(&dest.join("a (2).png"), b"second");

        let out = transfer(
            OpKind::Move,
            std::slice::from_ref(&a),
            &dest,
            Conflict::KeepBoth,
        );
        let landed = dest.join("a (3).png");
        assert_eq!(out.items, vec![Ok(landed.clone())]);
        assert_eq!(
            out.steps,
            vec![Step::MoveBack {
                from: landed.clone(),
                to: a.clone()
            }]
        );
        assert_eq!(fs::read(&landed).unwrap(), b"newcomer");
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"first");
        assert_eq!(fs::read(dest.join("a (2).png")).unwrap(), b"second");
    }

    #[test]
    fn two_sources_with_the_same_name_do_not_overwrite_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let x = write(&dir.path().join("x").join("a.png"), b"from x");
        let y = write(&dir.path().join("y").join("a.png"), b"from y");

        let skipped = transfer(OpKind::Move, &[x.clone(), y.clone()], &dest, Conflict::Skip);
        assert_eq!(
            skipped.items,
            vec![Ok(dest.join("a.png")), Err(FsError::Exists)]
        );
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"from x");
        assert_eq!(fs::read(&y).unwrap(), b"from y");

        let kept = transfer(OpKind::Move, &[y], &dest, Conflict::KeepBoth);
        assert_eq!(kept.items, vec![Ok(dest.join("a (2).png"))]);
        assert_eq!(fs::read(dest.join("a (2).png")).unwrap(), b"from y");
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"from x");
    }

    #[test]
    fn moving_into_the_current_directory_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("a.png"), b"a");
        let before = snapshot(dir.path());

        for conflict in [Conflict::Skip, Conflict::KeepBoth] {
            let out = transfer(OpKind::Move, std::slice::from_ref(&a), dir.path(), conflict);
            assert_eq!(out.items, vec![Ok(a.clone())]);
            assert!(out.steps.is_empty());
            assert!(out.hints.is_empty());
        }
        assert_eq!(snapshot(dir.path()), before);

        // 源已不在：照实报告，不当作成功。
        let gone = dir.path().join("gone.png");
        let out = transfer(OpKind::Move, &[gone], dir.path(), Conflict::Skip);
        assert_eq!(out.items, vec![Err(FsError::NotFound)]);

        // 复制到自己所在的目录不是空操作，而是重名。
        let out = transfer(
            OpKind::Copy,
            std::slice::from_ref(&a),
            dir.path(),
            Conflict::Skip,
        );
        assert_eq!(out.items, vec![Err(FsError::Exists)]);
        assert_eq!(snapshot(dir.path()), before);
        let out = transfer(
            OpKind::Copy,
            std::slice::from_ref(&a),
            dir.path(),
            Conflict::KeepBoth,
        );
        let copy = dir.path().join("a (2).png");
        assert_eq!(out.items, vec![Ok(copy.clone())]);
        assert_eq!(out.steps, vec![Step::Trash(copy.clone())]);
        assert_eq!(fs::read(&copy).unwrap(), b"a");
    }

    #[test]
    fn transfer_into_a_missing_directory_fails_every_item() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir.path().join("a.png"), b"a");
        let b = write(&dir.path().join("b.png"), b"b");
        let before = snapshot(dir.path());
        let missing = dir.path().join("missing");

        for kind in [OpKind::Move, OpKind::Copy] {
            let out = transfer(kind, &[a.clone(), b.clone()], &missing, Conflict::KeepBoth);
            assert_eq!(
                out.items,
                vec![Err(FsError::NotFound), Err(FsError::NotFound)]
            );
            assert!(out.steps.is_empty());
            assert!(out.hints.is_empty());
        }
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn undo_of_a_move_refuses_to_overwrite_a_newcomer() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let a = write(&dir.path().join("a.png"), b"moved");

        let out = transfer(
            OpKind::Move,
            std::slice::from_ref(&a),
            &dest,
            Conflict::Skip,
        );
        write(&a, b"newcomer");

        let undone = undo(&out.steps);
        assert_eq!(undone.done, 0);
        assert_eq!(undone.failed, vec![(dest.join("a.png"), FsError::Exists)]);
        assert!(undone.hints.is_empty());
        assert_eq!(fs::read(&a).unwrap(), b"newcomer");
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"moved");
    }

    #[test]
    fn undo_continues_after_a_failed_step() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let sources: Vec<PathBuf> = ["a.png", "b.png", "c.png"]
            .iter()
            .map(|n| write(&dir.path().join(n), n.as_bytes()))
            .collect();

        let out = transfer(OpKind::Move, &sources, &dest, Conflict::Skip);
        assert_eq!(out.steps.len(), 3);
        fs::remove_file(dest.join("b.png")).unwrap();

        let undone = undo(&out.steps);
        assert_eq!(undone.done, 2);
        assert_eq!(undone.failed, vec![(dest.join("b.png"), FsError::NotFound)]);
        assert_eq!(fs::read(&sources[0]).unwrap(), b"a.png");
        assert_eq!(fs::read(&sources[2]).unwrap(), b"c.png");
        // 倒序执行。
        assert_eq!(
            undone.hints,
            vec![
                FsHint::Renamed {
                    from: dest.join("c.png"),
                    to: sources[2].clone()
                },
                FsHint::Renamed {
                    from: dest.join("a.png"),
                    to: sources[0].clone()
                },
            ]
        );
    }

    #[test]
    fn make_dir_then_undo_removes_it_only_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let (made, step) = make_dir(dir.path(), "新文件夹").unwrap();
        assert_eq!(made, dir.path().join("新文件夹"));
        assert!(made.is_dir());
        let step = step.unwrap();
        assert_eq!(step, Step::RemoveEmptyDir(made.clone()));

        // 非空：跳过，不算失败。
        write(&made.join("a.png"), b"a");
        let undone = undo(std::slice::from_ref(&step));
        assert_no_failures(&undone);
        assert_eq!(undone.done, 1);
        assert!(undone.hints.is_empty());
        assert_eq!(fs::read(made.join("a.png")).unwrap(), b"a");

        // 空：删掉。
        fs::remove_file(made.join("a.png")).unwrap();
        let undone = undo(std::slice::from_ref(&step));
        assert_no_failures(&undone);
        assert_eq!(undone.done, 1);
        assert!(made.symlink_metadata().is_err());

        assert_eq!(make_dir(dir.path(), "a/b"), Err(FsError::InvalidName));
    }

    #[test]
    fn make_dir_reuses_an_existing_directory_without_a_step() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("已有");
        write(&existing.join("a.png"), b"a");

        assert_eq!(make_dir(dir.path(), "已有"), Ok((existing.clone(), None)));
        assert_eq!(fs::read(existing.join("a.png")).unwrap(), b"a");

        // 同名的是文件：不能当目录用。
        write(&dir.path().join("文件"), b"f");
        assert_eq!(make_dir(dir.path(), "文件"), Err(FsError::Exists));
    }

    #[test]
    fn make_dir_reuses_the_on_disk_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("sub");
        write(&existing.join("a.png"), b"a");

        assert_eq!(make_dir(dir.path(), "sub"), Ok((existing.clone(), None)));
        // 不分大小写的卷上 "Sub" 就是 "sub"：返回磁盘上的写法，不是输入的写法。
        if dir.path().join("SUB").symlink_metadata().is_ok() {
            assert_eq!(make_dir(dir.path(), "Sub"), Ok((existing.clone(), None)));
        }
        assert_eq!(snapshot(dir.path()).len(), 2);
    }

    #[test]
    fn undo_counts_an_already_removed_directory_as_done() {
        let dir = tempfile::tempdir().unwrap();
        let (made, step) = make_dir(dir.path(), "新文件夹").unwrap();
        fs::remove_dir(&made).unwrap();

        let undone = undo(&[step.unwrap()]);
        assert_no_failures(&undone);
        assert_eq!(undone.done, 1);
    }

    #[test]
    fn hints_cover_exactly_the_successful_items() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        let a = write(&dir.path().join("a.png"), b"a");
        let missing = dir.path().join("missing.png");
        let c = write(&dir.path().join("c.png"), b"c");
        write(&dest.join("c.png"), b"occupied");

        let moved = transfer(
            OpKind::Move,
            &[a.clone(), missing.clone(), c.clone()],
            &dest,
            Conflict::Skip,
        );
        assert_eq!(
            moved.items,
            vec![
                Ok(dest.join("a.png")),
                Err(FsError::NotFound),
                Err(FsError::Exists)
            ]
        );
        assert_eq!(
            moved.hints,
            vec![FsHint::Renamed {
                from: a.clone(),
                to: dest.join("a.png")
            }]
        );

        let copied = transfer(
            OpKind::Copy,
            &[c.clone(), missing.clone()],
            &dest,
            Conflict::KeepBoth,
        );
        assert_eq!(
            copied.items,
            vec![Ok(dest.join("c (2).png")), Err(FsError::NotFound)]
        );
        assert_eq!(copied.hints, vec![FsHint::Touched(dest.join("c (2).png"))]);

        let renamed = rename(&c, "d.png");
        assert_eq!(
            renamed.hints,
            vec![FsHint::Renamed {
                from: c.clone(),
                to: dir.path().join("d.png")
            }]
        );
        let failed = rename(&missing, "e.png");
        assert_eq!(failed.items, vec![Err(FsError::NotFound)]);
        assert!(failed.hints.is_empty());
    }
}
