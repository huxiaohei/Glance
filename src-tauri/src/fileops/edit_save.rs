//! 编辑结果落盘：保存副本、覆盖原图、另存到别处。都先写同目录临时文件再不覆盖地改名，
//! 任何失败都不留下临时文件；覆盖原图先把原图移进废纸篓，改名失败就放回原处。

use std::fs;
use std::path::{Path, PathBuf};

use super::fsx::{self, FsError};
use super::trash;
use super::undo::Step;
use crate::catalog::reconcile::FsHint;

/// 副本重名时最多试到的序号。
const MAX_COPY_N: u32 = 999;

#[derive(Debug, Clone, PartialEq)]
pub enum SaveTarget {
    /// 在原图旁边另存副本：原名 + 后缀 + 扩展名，重名追加 `_2`、`_3`……
    Copy,
    /// 替换原图（扩展名不同时换成新扩展名）；原图进废纸篓。
    Overwrite,
    /// 存到给定路径（系统存储对话框给出），已存在一律 `Exists`。
    SaveAs(PathBuf),
}

#[derive(Debug)]
pub struct SaveOutcome {
    /// 新文件的路径。
    pub path: PathBuf,
    pub steps: Vec<Step>,
    pub hints: Vec<FsHint>,
}

/// 把 bytes 写到 target 指定的位置。`out_ext` 是输出扩展名（不带点），`suffix` 是副本后缀
/// （`_compressed`、`_converted` 或空串）。
pub fn save_bytes(
    src: &Path,
    bytes: &[u8],
    out_ext: &str,
    suffix: &str,
    target: &SaveTarget,
) -> Result<SaveOutcome, FsError> {
    match target {
        SaveTarget::Copy => save_copy(src, bytes, out_ext, suffix),
        SaveTarget::Overwrite => overwrite(src, bytes, out_ext),
        SaveTarget::SaveAs(path) => save_as(path, bytes),
    }
}

fn dir_of(path: &Path) -> &Path {
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    }
}

/// 写临时文件后不覆盖地改名到 to；失败时删掉临时文件。
fn write_then_rename(bytes: &[u8], to: &Path) -> Result<(), FsError> {
    let tmp = fsx::write_temp(dir_of(to), bytes)?;
    fsx::rename_noreplace(&tmp, to).inspect_err(|_| fsx::discard_temp(&tmp))
}

fn save_copy(
    src: &Path,
    bytes: &[u8],
    out_ext: &str,
    suffix: &str,
) -> Result<SaveOutcome, FsError> {
    let base = src.with_extension(out_ext);
    let tmp = fsx::write_temp(dir_of(src), bytes)?;
    for n in 1..=MAX_COPY_N {
        let to = fsx::suffixed(&base, suffix, n);
        match fsx::rename_noreplace(&tmp, &to) {
            Ok(()) => {
                return Ok(SaveOutcome {
                    steps: vec![Step::Trash(to.clone())],
                    hints: vec![FsHint::Touched(to.clone())],
                    path: to,
                });
            }
            Err(FsError::Exists) => continue,
            Err(e) => {
                fsx::discard_temp(&tmp);
                return Err(e);
            }
        }
    }
    fsx::discard_temp(&tmp);
    Err(FsError::Exists)
}

/// 覆盖：目标是原路径（扩展名相同）或原名 + 新扩展名。先写临时文件，再把原图移进废纸篓，
/// 再把临时文件改名到目标；改名失败就把原图放回。撤销倒序执行：先把新文件移进废纸篓，再放回原图。
fn overwrite(src: &Path, bytes: &[u8], out_ext: &str) -> Result<SaveOutcome, FsError> {
    let same_ext = src
        .extension()
        .is_some_and(|e| e.to_string_lossy() == out_ext);
    let to = if same_ext {
        src.to_path_buf()
    } else {
        src.with_extension(out_ext)
    };
    // 新扩展名的名字已被占用：什么都不动。（最终的保证仍是不覆盖的改名。）
    if to != src && to.symlink_metadata().is_ok() {
        return Err(FsError::Exists);
    }
    let tmp = fsx::write_temp(dir_of(src), bytes)?;
    // 新文件沿用原文件的权限（私有的 0600 图片不能因覆盖变成 0644）；读不到就保持默认。
    if let Ok(meta) = fs::metadata(src) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    let handle = match trash::move_to_trash(src) {
        Ok(h) => h,
        Err(e) => {
            fsx::discard_temp(&tmp);
            return Err(FsError::from(e));
        }
    };
    if let Err(e) = final_rename(&tmp, &to) {
        fsx::discard_temp(&tmp);
        // 放回失败时原图仍在废纸篓里，没有丢；报改名本身的错。
        let _ = trash::restore(&handle);
        return Err(e);
    }
    let mut hints = vec![FsHint::Touched(to.clone())];
    if to != src {
        hints.insert(0, FsHint::Touched(src.to_path_buf()));
    }
    Ok(SaveOutcome {
        steps: vec![Step::Restore(handle), Step::Trash(to.clone())],
        hints,
        path: to,
    })
}

fn final_rename(tmp: &Path, to: &Path) -> Result<(), FsError> {
    #[cfg(test)]
    if fault::take() {
        return Err(FsError::DiskFull);
    }
    fsx::rename_noreplace(tmp, to)
}

fn save_as(to: &Path, bytes: &[u8]) -> Result<SaveOutcome, FsError> {
    write_then_rename(bytes, to)?;
    Ok(SaveOutcome {
        path: to.to_path_buf(),
        steps: vec![Step::Trash(to.to_path_buf())],
        hints: vec![FsHint::Touched(to.to_path_buf())],
    })
}

/// 测试用的故障注入：覆盖原图时最后一步改名失败（只作用于当前线程的下一次）。
#[cfg(test)]
mod fault {
    use std::cell::Cell;

    thread_local!(static FAIL_RENAME: Cell<bool> = const { Cell::new(false) });

    pub fn arm() {
        FAIL_RENAME.with(|f| f.set(true));
    }

    pub fn take() -> bool {
        FAIL_RENAME.with(|f| f.replace(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fileops::ops;
    use std::fs;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn dir_with(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, content) in files {
            fs::write(dir.path().join(name), content).unwrap();
        }
        dir
    }

    #[test]
    fn copy_names_increment() {
        let d = dir_with(&[("hero.png", b"orig"), ("hero_compressed.png", b"old")]);
        let src = d.path().join("hero.png");
        let out = save_bytes(&src, b"new", "png", "_compressed", &SaveTarget::Copy).unwrap();
        assert_eq!(out.path, d.path().join("hero_compressed_2.png"));
        assert_eq!(fs::read(&out.path).unwrap(), b"new");
        assert_eq!(fs::read(&src).unwrap(), b"orig");
        assert_eq!(
            fs::read(d.path().join("hero_compressed.png")).unwrap(),
            b"old"
        );
        assert_eq!(out.steps, vec![Step::Trash(out.path.clone())]);
        assert_eq!(out.hints, vec![FsHint::Touched(out.path.clone())]);
        let again = save_bytes(&src, b"3", "png", "_compressed", &SaveTarget::Copy).unwrap();
        assert_eq!(again.path, d.path().join("hero_compressed_3.png"));
    }

    #[test]
    fn convert_copy_uses_new_extension() {
        let d = dir_with(&[("hero.png", b"orig")]);
        let src = d.path().join("hero.png");
        let out = save_bytes(&src, b"w", "webp", "", &SaveTarget::Copy).unwrap();
        assert_eq!(out.path, d.path().join("hero.webp"));
        let out = save_bytes(&src, b"w2", "webp", "", &SaveTarget::Copy).unwrap();
        assert_eq!(out.path, d.path().join("hero_2.webp"));
        assert_eq!(fs::read(&out.path).unwrap(), b"w2");
    }

    #[test]
    fn convert_same_format_uses_converted_suffix() {
        let d = dir_with(&[("photo.jpeg", b"orig")]);
        let src = d.path().join("photo.jpeg");
        let out = save_bytes(&src, b"j", "jpeg", "_converted", &SaveTarget::Copy).unwrap();
        assert_eq!(out.path, d.path().join("photo_converted.jpeg"));
        assert_eq!(fs::read(&src).unwrap(), b"orig");
    }

    #[test]
    #[ignore = "覆盖原图会把文件移进真实废纸篓（只动本测试临时目录里的文件）"]
    fn overwrite_same_ext_replaces_and_undo_restores() {
        let d = dir_with(&[("hero.png", b"orig")]);
        let src = d.path().join("hero.png");
        let out = save_bytes(&src, b"new", "png", "_compressed", &SaveTarget::Overwrite).unwrap();
        assert_eq!(out.path, src);
        assert_eq!(fs::read(&src).unwrap(), b"new");
        assert_eq!(names(d.path()), vec!["hero.png"]);
        assert!(matches!(
            out.steps.as_slice(),
            [Step::Restore(h), Step::Trash(t)] if h.original == src && *t == src
        ));
        assert_eq!(out.hints, vec![FsHint::Touched(src.clone())]);

        let undone = ops::undo(&out.steps);
        assert!(undone.failed.is_empty(), "{:?}", undone.failed);
        assert_eq!(fs::read(&src).unwrap(), b"orig");
        assert_eq!(names(d.path()), vec!["hero.png"]);
        // 先把新内容移进废纸篓，再放回原图。
        assert_eq!(
            undone.hints,
            vec![FsHint::Touched(src.clone()), FsHint::Touched(src.clone())]
        );
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "覆盖原图会把文件移进真实废纸篓（只动本测试临时目录里的文件）"]
    fn overwrite_keeps_original_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir_with(&[("priv.png", b"orig")]);
        let src = d.path().join("priv.png");
        fs::set_permissions(&src, fs::Permissions::from_mode(0o600)).unwrap();
        save_bytes(&src, b"new", "png", "", &SaveTarget::Overwrite).unwrap();
        let mode = fs::metadata(&src).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    #[ignore = "覆盖原图会把文件移进真实废纸篓（只动本测试临时目录里的文件）"]
    fn overwrite_new_ext_replaces_original_and_undo_restores() {
        let d = dir_with(&[("hero.png", b"orig")]);
        let src = d.path().join("hero.png");
        let out = save_bytes(&src, b"jpg", "jpg", "", &SaveTarget::Overwrite).unwrap();
        assert_eq!(out.path, d.path().join("hero.jpg"));
        assert_eq!(names(d.path()), vec!["hero.jpg"]);
        assert_eq!(
            out.hints,
            vec![
                FsHint::Touched(src.clone()),
                FsHint::Touched(out.path.clone())
            ]
        );
        let undone = ops::undo(&out.steps);
        assert!(undone.failed.is_empty(), "{:?}", undone.failed);
        assert_eq!(names(d.path()), vec!["hero.png"]);
        assert_eq!(fs::read(&src).unwrap(), b"orig");
    }

    #[test]
    fn overwrite_new_ext_taken_touches_nothing() {
        let d = dir_with(&[("hero.png", b"orig"), ("hero.jpg", b"other")]);
        let src = d.path().join("hero.png");
        let err = save_bytes(&src, b"new", "jpg", "", &SaveTarget::Overwrite).unwrap_err();
        assert_eq!(err, FsError::Exists);
        assert_eq!(names(d.path()), vec!["hero.jpg", "hero.png"]);
        assert_eq!(fs::read(&src).unwrap(), b"orig");
        assert_eq!(fs::read(d.path().join("hero.jpg")).unwrap(), b"other");
    }

    #[test]
    #[ignore = "覆盖原图会把文件移进真实废纸篓（只动本测试临时目录里的文件）"]
    fn overwrite_write_failure_restores_original() {
        let d = dir_with(&[("hero.png", b"orig")]);
        let src = d.path().join("hero.png");
        fault::arm();
        let err =
            save_bytes(&src, b"new", "png", "_compressed", &SaveTarget::Overwrite).unwrap_err();
        assert_eq!(err, FsError::DiskFull);
        assert_eq!(names(d.path()), vec!["hero.png"]);
        assert_eq!(fs::read(&src).unwrap(), b"orig");

        // 换扩展名时同样放回原图，不留新文件。
        fault::arm();
        let err = save_bytes(&src, b"new", "webp", "", &SaveTarget::Overwrite).unwrap_err();
        assert_eq!(err, FsError::DiskFull);
        assert_eq!(names(d.path()), vec!["hero.png"]);
        assert_eq!(fs::read(&src).unwrap(), b"orig");
    }

    #[test]
    fn overwrite_missing_source_touches_nothing() {
        let d = dir_with(&[]);
        let src = d.path().join("gone.png");
        let err = save_bytes(&src, b"new", "png", "", &SaveTarget::Overwrite).unwrap_err();
        assert_eq!(err, FsError::NotFound);
        assert!(names(d.path()).is_empty());
    }

    #[test]
    fn save_as_never_overwrites() {
        let d = dir_with(&[("hero.png", b"orig"), ("taken.webp", b"other")]);
        let src = d.path().join("hero.png");
        let taken = d.path().join("taken.webp");
        let err =
            save_bytes(&src, b"new", "webp", "", &SaveTarget::SaveAs(taken.clone())).unwrap_err();
        assert_eq!(err, FsError::Exists);
        assert_eq!(fs::read(&taken).unwrap(), b"other");
        // 另存到原图本身也不行。
        let err =
            save_bytes(&src, b"new", "png", "", &SaveTarget::SaveAs(src.clone())).unwrap_err();
        assert_eq!(err, FsError::Exists);
        assert_eq!(fs::read(&src).unwrap(), b"orig");

        let other = tempfile::tempdir().unwrap();
        let to = other.path().join("out.webp");
        let out = save_bytes(&src, b"new", "webp", "", &SaveTarget::SaveAs(to.clone())).unwrap();
        assert_eq!(out.path, to);
        assert_eq!(fs::read(&to).unwrap(), b"new");
        assert_eq!(out.steps, vec![Step::Trash(to.clone())]);
        assert_eq!(out.hints, vec![FsHint::Touched(to)]);
    }

    #[test]
    fn no_tmp_left_behind() {
        let d = dir_with(&[("hero.png", b"orig"), ("hero.jpg", b"other")]);
        let src = d.path().join("hero.png");
        // 副本成功、另存冲突、覆盖冲突、另存到不存在的目录：都不留临时文件。
        save_bytes(&src, b"c", "png", "_compressed", &SaveTarget::Copy).unwrap();
        let taken = d.path().join("hero.jpg");
        assert!(save_bytes(&src, b"x", "jpg", "", &SaveTarget::SaveAs(taken)).is_err());
        assert!(save_bytes(&src, b"x", "jpg", "", &SaveTarget::Overwrite).is_err());
        let missing = d.path().join("nope").join("x.png");
        assert_eq!(
            save_bytes(&src, b"x", "png", "", &SaveTarget::SaveAs(missing)).unwrap_err(),
            FsError::NotFound
        );
        // 副本名用尽：999 个都被占用时报 Exists，也不留临时文件。
        let e = dir_with(&[("a.png", b"a"), ("a_c.png", b"1")]);
        for n in 2..=MAX_COPY_N {
            fs::write(e.path().join(format!("a_c_{n}.png")), b"x").unwrap();
        }
        let a = e.path().join("a.png");
        assert_eq!(
            save_bytes(&a, b"x", "png", "_c", &SaveTarget::Copy).unwrap_err(),
            FsError::Exists
        );
        for dir in [d.path(), e.path()] {
            assert!(
                names(dir).iter().all(|n| !n.starts_with(".glance-tmp-")),
                "{:?}",
                names(dir)
            );
        }
        assert_eq!(
            names(d.path()),
            vec!["hero.jpg", "hero.png", "hero_compressed.png"]
        );
    }
}
