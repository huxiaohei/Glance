//! 这些测试会真的动系统废纸篓，只在显式指定 `--ignored` 时运行。
//! 只处理自己在用户目录下新建的临时文件。

use glance_lib::fileops::ops;
use glance_lib::fileops::trash::{TrashError, move_to_trash, restore};
use std::path::{Path, PathBuf};

fn scratch_file(name: &str, content: &[u8]) -> (tempfile::TempDir, PathBuf) {
    let home = dirs::home_dir().expect("home dir");
    let dir = tempfile::Builder::new()
        .prefix(".glance-test-")
        .tempdir_in(home)
        .unwrap();
    let file = dir.path().join(name);
    std::fs::write(&file, content).unwrap();
    (dir, file)
}

#[test]
#[ignore]
fn trash_then_restore_brings_file_back() {
    let (dir, file) = scratch_file("可恢复 的图.png", b"payload");
    let handle = move_to_trash(&file).unwrap();
    assert!(!file.exists());
    restore(&handle).unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"payload");
    drop(dir);
}

#[test]
#[ignore]
fn restore_refuses_to_overwrite() {
    let (dir, file) = scratch_file("a.png", b"old");
    let handle = move_to_trash(&file).unwrap();
    std::fs::write(&file, b"new").unwrap();
    assert!(matches!(restore(&handle), Err(TrashError::Occupied(_))));
    assert_eq!(std::fs::read(&file).unwrap(), b"new");
    drop(dir);
}

#[test]
#[ignore]
fn trashing_missing_file_is_not_found() {
    let (dir, file) = scratch_file("b.png", b"x");
    std::fs::remove_file(&file).unwrap();
    assert!(matches!(move_to_trash(&file), Err(TrashError::NotFound(_))));
    drop(dir);
}

fn names_and_contents(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let path = e.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read(&path).unwrap())
        })
        .collect();
    out.sort();
    out
}

#[test]
#[ignore]
fn trash_then_undo_restores_the_tree() {
    let (dir, first) = scratch_file("一.png", b"1");
    let second = dir.path().join("二.png");
    let third = dir.path().join("三.png");
    std::fs::write(&second, b"2").unwrap();
    std::fs::write(&third, b"3").unwrap();
    let before = names_and_contents(dir.path());

    let paths = vec![first.clone(), second.clone(), third.clone()];
    let out = ops::trash(&paths);
    assert_eq!(
        out.items,
        vec![Ok(first.clone()), Ok(second.clone()), Ok(third.clone())]
    );
    assert_eq!(out.steps.len(), 3);
    assert!(names_and_contents(dir.path()).is_empty());

    let undone = ops::undo(&out.steps);
    assert!(undone.failed.is_empty(), "{:?}", undone.failed);
    assert_eq!(undone.done, 3);
    assert_eq!(names_and_contents(dir.path()), before);
    drop(dir);
}
