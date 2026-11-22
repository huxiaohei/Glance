//! 这些测试会真的动系统废纸篓，只在显式指定 `--ignored` 时运行。
//! 只处理自己在用户目录下新建的临时文件。

use glance_lib::fileops::trash::{TrashError, move_to_trash, restore};
use std::path::PathBuf;

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
