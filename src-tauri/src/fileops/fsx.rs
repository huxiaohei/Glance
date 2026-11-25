//! 不覆盖用户文件的文件系统基本操作。改名、移动、复制都建立在"目标已存在就失败"的原子改名上，
//! 绝不先检查再改名。

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsError {
    NotFound, // 源不存在
    Exists,   // 目标已存在
    InvalidName,
    ReadOnly, // 只读目录或只读文件系统
    DiskFull,
    Denied,        // 其他权限问题
    RestoreDenied, // 系统拒绝从废纸篓放回，需要用户手动恢复
    NotInTrash,
    TooLarge, // 复制图片到剪贴板时超过像素上限
    Other,    // 其余系统错误
}

impl From<&io::Error> for FsError {
    /// 按 ErrorKind 与 raw_os_error 归类。
    fn from(err: &io::Error) -> Self {
        #[cfg(windows)]
        {
            // ERROR_WRITE_PROTECT：介质写保护。标准库没有把它归到 ReadOnlyFilesystem。（未在本机编译）
            if err.raw_os_error() == Some(19) {
                return FsError::ReadOnly;
            }
        }
        match err.kind() {
            ErrorKind::NotFound => FsError::NotFound,
            ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => FsError::Exists,
            ErrorKind::InvalidFilename => FsError::InvalidName,
            ErrorKind::ReadOnlyFilesystem => FsError::ReadOnly,
            ErrorKind::StorageFull | ErrorKind::QuotaExceeded => FsError::DiskFull,
            ErrorKind::PermissionDenied => FsError::Denied,
            _ => FsError::Other,
        }
    }
}

/// 原子改名，目标已存在则 Exists，绝不覆盖。源和目标是同一个文件（只改大小写）时允许。
/// macOS：renamex_np(RENAME_EXCL)；Windows：MoveFileExW 不带 REPLACE_EXISTING（未在本机编译）；
/// 其他系统：hard_link + remove_file 的退路。
pub fn rename_noreplace(from: &Path, to: &Path) -> Result<(), FsError> {
    rename_noreplace_io(from, to).map_err(|e| FsError::from(&e))
}

/// 同 [`rename_noreplace`]，但保留原始的 io::Error，供需要自行归类错误的调用方（废纸篓放回）使用。
pub(crate) fn rename_noreplace_io(from: &Path, to: &Path) -> io::Result<()> {
    if is_case_only_change(from, to) {
        // 目标就是源本身，普通改名不会动到别的文件。
        return fs::rename(from, to);
    }
    platform::rename_excl(from, to)
}

/// 同一目录里、名字只差大小写、且两个路径指向同一个文件。
/// 不分大小写的卷上，RENAME_EXCL（以及其他系统的硬链接退路）可能把这种情形当成"目标已存在"；
/// 本机 APFS 的 renamex_np 实测会放行，但其他文件系统不保证。
#[cfg(unix)]
fn is_case_only_change(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Some(from_name), Some(to_name)) = (from.file_name(), to.file_name()) else {
        return false;
    };
    let (Some(from_name), Some(to_name)) = (from_name.to_str(), to_name.to_str()) else {
        return false;
    };
    if from_name == to_name || from_name.to_lowercase() != to_name.to_lowercase() {
        return false;
    }
    let same = |a: &fs::Metadata, b: &fs::Metadata| a.dev() == b.dev() && a.ino() == b.ino();
    let parent = |p: &Path| match p.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let entries = (from.symlink_metadata(), to.symlink_metadata());
    let parents = (fs::metadata(parent(from)), fs::metadata(parent(to)));
    matches!((entries, parents), ((Ok(a), Ok(b)), (Ok(pa), Ok(pb))) if same(&a, &b) && same(&pa, &pb))
}

/// Windows 不需要特判：目标与源是同一个文件时，MoveFileExW 不带 REPLACE_EXISTING 也允许改名
/// （MS-FSA FileRenameInformation：只有 TargetExistsSameFile 为假时才报名字冲突）。
#[cfg(not(unix))]
fn is_case_only_change(_from: &Path, _to: &Path) -> bool {
    false
}

/// 移动文件：同卷走 rename_noreplace；跨卷则复制到目标目录的临时文件 → rename_noreplace → 删除源。
pub fn move_noreplace(from: &Path, to: &Path) -> Result<(), FsError> {
    match rename_noreplace_io(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => copy_then_remove(from, to),
        Err(e) => Err(FsError::from(&e)),
    }
}

fn is_cross_device(err: &io::Error) -> bool {
    // EXDEV（macOS / Linux 都是 18）；ERROR_NOT_SAME_DEVICE（17）。
    #[cfg(unix)]
    const CROSS_DEVICE: i32 = 18;
    #[cfg(windows)]
    const CROSS_DEVICE: i32 = 17;
    #[cfg(not(any(unix, windows)))]
    const CROSS_DEVICE: i32 = -1;
    err.kind() == ErrorKind::CrossesDevices || err.raw_os_error() == Some(CROSS_DEVICE)
}

/// 跨卷移动：先完整复制，成功后删源。删源失败就把刚复制的删掉，绝不悄悄留下两份。
pub(crate) fn copy_then_remove(from: &Path, to: &Path) -> Result<(), FsError> {
    copy_noreplace(from, to)?;
    after_source_removal(fs::remove_file(from), to)
}

/// 跨卷移动删源之后的收尾。源在复制后已经不见了（NotFound）时，副本是仅存的一份，留着它、
/// 当作移动成功；其他删源失败则删掉副本（清理失败也照样报原来的错）。
fn after_source_removal(removed: io::Result<()>, copy: &Path) -> Result<(), FsError> {
    match removed {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(copy);
            Err(FsError::from(&e))
        }
    }
}

/// 复制文件：写目标目录的临时文件并 fsync → rename_noreplace；失败时删掉临时文件。
/// 保留修改时间与权限位。扩展属性（如 macOS 的访达标签）不保留，已记入后续事项。
pub fn copy_noreplace(from: &Path, to: &Path) -> Result<(), FsError> {
    let mut source = File::open(from).map_err(|e| FsError::from(&e))?;
    // 只为尽早失败、省掉一次白复制；真正的保证在最后的不覆盖改名。
    if to.symlink_metadata().is_ok() {
        return Err(FsError::Exists);
    }
    let dir = match to.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    // 始终通过 create_new 独占建出的这个句柄写入，不再按名字重新打开临时文件。
    let (temp_path, mut temp) = create_temp_file(dir).map_err(|e| FsError::from(&e))?;
    let written = (|| -> io::Result<()> {
        let meta = source.metadata()?;
        io::copy(&mut source, &mut temp)?;
        temp.set_modified(meta.modified()?)?;
        temp.sync_all()?;
        // 权限放在最后设：源是只读时，临时文件变只读也不会挡住前面的写入。
        temp.set_permissions(meta.permissions())?;
        drop(temp);
        rename_noreplace_io(&temp_path, to)
    })();
    if let Err(e) = written {
        remove_temp(&temp_path);
        return Err(FsError::from(&e));
    }
    Ok(())
}

/// 尽力删掉临时文件。它可能已经被设成只读：Windows 上只读文件删不掉，先清掉只读标记
/// （unix 上能不能删只看目录权限，清不清都无妨）。
fn remove_temp(path: &Path) {
    if let Ok(meta) = path.symlink_metadata() {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
    let _ = fs::remove_file(path);
}

/// 在 dir 里新建临时文件 `.glance-tmp-<进程号>-<递增序号>`（点开头，扫描会跳过）。
fn create_temp_file(dir: &Path) -> io::Result<(PathBuf, File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".glance-tmp-{}-{seq}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            // 上次运行残留的同名临时文件：换下一个序号。
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// "a.png", 2 → "a (2).png"；没有扩展名时 "a (2)"。
pub fn numbered(path: &Path, n: u32) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let name = match path.extension() {
        Some(ext) => format!("{stem} ({n}).{}", ext.to_string_lossy()),
        None => format!("{stem} ({n})"),
    };
    path.with_file_name(name)
}

/// 在扩展名前加后缀与序号："a/hero.png", "_compressed", 1 → "a/hero_compressed.png"；
/// n ≥ 2 → "a/hero_compressed_2.png"；后缀为空时 n = 1 就是原名，n = 2 为 "a/hero_2.png"。
pub fn suffixed(path: &Path, suffix: &str, n: u32) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let number = if n >= 2 {
        format!("_{n}")
    } else {
        String::new()
    };
    let name = match path.extension() {
        Some(ext) => format!("{stem}{suffix}{number}.{}", ext.to_string_lossy()),
        None => format!("{stem}{suffix}{number}"),
    };
    path.with_file_name(name)
}

/// 在 dir 里新建临时文件，写入 bytes 并 fsync，返回它的路径；任何一步失败都删掉临时文件。
/// 之后由调用方 [`rename_noreplace`] 到目标，失败时用 [`discard_temp`] 删掉。
pub fn write_temp(dir: &Path, bytes: &[u8]) -> Result<PathBuf, FsError> {
    let (path, mut file) = create_temp_file(dir).map_err(|e| FsError::from(&e))?;
    let written = (|| -> io::Result<()> {
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()
    })();
    drop(file);
    match written {
        Ok(()) => Ok(path),
        Err(e) => {
            remove_temp(&path);
            Err(FsError::from(&e))
        }
    }
}

/// 尽力删掉 [`write_temp`] 写出的临时文件。
pub fn discard_temp(path: &Path) {
    remove_temp(path);
}

/// 文件名或目录名是否可用。拒绝：空、首尾空格、以 '.' 开头、"." 与 ".."、含 '/' '\\' 或 NUL；
/// 另拒绝 Windows 上不可用的名字（含 <>:"|?* 或控制字符、以 '.' 结尾、保留名 CON PRN AUX NUL COM1–9 LPT1–9，
/// 不分大小写、带不带扩展名都算）——两个平台用同一套规则，免得在一边起的名字到另一边打不开。
pub fn validate_name(name: &str) -> Result<(), FsError> {
    const FORBIDDEN: &[char] = &['/', '\\', '<', '>', ':', '"', '|', '?', '*'];
    let bad = name.is_empty()
        || name.starts_with(' ')
        || name.ends_with(' ')
        || name.starts_with('.')
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || FORBIDDEN.contains(&c))
        || is_reserved_windows_name(name);
    if bad {
        Err(FsError::InvalidName)
    } else {
        Ok(())
    }
}

fn is_reserved_windows_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    match base.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        // 只看字节，不按字节下标切字符串：非 ASCII 的名字不会是保留名。
        _ => matches!(
            base.as_bytes(),
            [b'C', b'O', b'M', b'1'..=b'9'] | [b'L', b'P', b'T', b'1'..=b'9']
        ),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// 原子改名；目标已存在时失败（EEXIST），绝不覆盖。
    pub fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        // SAFETY: 两个指针来自存活的 CString，以 NUL 结尾，调用期间有效。
        let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

// 未在本机编译（本机为 macOS）。
#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut units: Vec<u16> = path.as_os_str().encode_wide().collect();
        if units.contains(&0) {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidFilename));
        }
        units.push(0);
        Ok(units)
    }

    /// 原子改名；不带 MOVEFILE_REPLACE_EXISTING，目标已存在时失败，绝不覆盖。
    /// 也不带 MOVEFILE_COPY_ALLOWED：跨卷时报 ERROR_NOT_SAME_DEVICE，由调用方自己复制。
    pub fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
        let from = wide(from)?;
        let to = wide(to)?;
        // SAFETY: 两个指针来自存活的 Vec<u16>，以 0 结尾，调用期间有效。
        let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use std::fs;
    use std::path::Path;

    /// 退路：硬链接在目标已存在时失败（EEXIST），成功后再删源。只支持文件。
    pub fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
        fs::hard_link(from, to)?;
        if let Err(e) = fs::remove_file(from) {
            let _ = fs::remove_file(to);
            return Err(e);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn rename_noreplace_refuses_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.png");
        let to = dir.path().join("b.png");
        fs::write(&from, b"source").unwrap();
        fs::write(&to, b"target").unwrap();

        assert_eq!(rename_noreplace(&from, &to), Err(FsError::Exists));
        assert_eq!(fs::read(&from).unwrap(), b"source");
        assert_eq!(fs::read(&to).unwrap(), b"target");
    }

    #[test]
    fn rename_noreplace_allows_case_only_change() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.png");
        let to = dir.path().join("A.png");
        fs::write(&from, b"pixels").unwrap();
        // 不分大小写的卷上 A.png 指向同一个文件，这正是要覆盖到的情形；
        // 分大小写的卷上它只是普通改名，测试仍然成立。
        let case_insensitive = to.symlink_metadata().is_ok();
        eprintln!("temp dir case-insensitive: {case_insensitive}");

        assert_eq!(rename_noreplace(&from, &to), Ok(()));
        assert_eq!(names_in(dir.path()), vec!["A.png".to_string()]);
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
    }

    #[test]
    fn rename_noreplace_reports_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("missing.png");
        let to = dir.path().join("b.png");
        assert_eq!(rename_noreplace(&from, &to), Err(FsError::NotFound));
    }

    #[test]
    fn copy_noreplace_refuses_an_existing_target_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.png");
        let to = dir.path().join("b.png");
        fs::write(&from, b"source").unwrap();
        fs::write(&to, b"target").unwrap();

        assert_eq!(copy_noreplace(&from, &to), Err(FsError::Exists));
        assert_eq!(fs::read(&to).unwrap(), b"target");
        assert_eq!(fs::read(&from).unwrap(), b"source");
        assert_eq!(
            names_in(dir.path()),
            vec!["a.png".to_string(), "b.png".to_string()]
        );
    }

    #[test]
    fn copy_noreplace_preserves_content_and_mtime() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"pixels").unwrap();
        let mtime = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&from)
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        assert_eq!(copy_noreplace(&from, &to), Ok(()));
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
        assert_eq!(fs::read(&from).unwrap(), b"pixels");
        assert_eq!(fs::metadata(&to).unwrap().modified().unwrap(), mtime);
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn copy_noreplace_preserves_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"pixels").unwrap();
        fs::set_permissions(&from, fs::Permissions::from_mode(0o640)).unwrap();

        assert_eq!(copy_noreplace(&from, &to), Ok(()));
        assert_eq!(
            fs::metadata(&to).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn copy_noreplace_copies_a_read_only_source() {
        use std::os::unix::fs::PermissionsExt;
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"pixels").unwrap();
        fs::set_permissions(&from, fs::Permissions::from_mode(0o444)).unwrap();

        assert_eq!(copy_noreplace(&from, &to), Ok(()));
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
        assert_eq!(
            fs::metadata(&to).unwrap().permissions().mode() & 0o777,
            0o444
        );
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn copy_noreplace_with_a_read_only_source_refuses_an_existing_target() {
        use std::os::unix::fs::PermissionsExt;
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"source").unwrap();
        fs::set_permissions(&from, fs::Permissions::from_mode(0o444)).unwrap();
        fs::write(&to, b"target").unwrap();

        assert_eq!(copy_noreplace(&from, &to), Err(FsError::Exists));
        assert_eq!(fs::read(&to).unwrap(), b"target");
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn cross_volume_fallback_moves_a_read_only_source() {
        use std::os::unix::fs::PermissionsExt;
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"pixels").unwrap();
        fs::set_permissions(&from, fs::Permissions::from_mode(0o444)).unwrap();

        assert_eq!(copy_then_remove(&from, &to), Ok(()));
        assert!(from.symlink_metadata().is_err());
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[test]
    fn temp_cleanup_removes_a_read_only_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".glance-tmp-test");
        fs::write(&temp, b"x").unwrap();
        let mut perms = fs::metadata(&temp).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&temp, perms).unwrap();

        remove_temp(&temp);
        assert!(names_in(dir.path()).is_empty());
    }

    #[test]
    fn move_noreplace_moves_within_a_volume() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let from = dir.path().join("a.png");
        let to = dir.path().join("sub").join("a.png");
        fs::write(&from, b"pixels").unwrap();

        assert_eq!(move_noreplace(&from, &to), Ok(()));
        assert!(from.symlink_metadata().is_err());
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
    }

    #[test]
    fn cross_volume_fallback_copies_then_removes() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"pixels").unwrap();

        assert_eq!(copy_then_remove(&from, &to), Ok(()));
        assert!(from.symlink_metadata().is_err());
        assert_eq!(fs::read(&to).unwrap(), b"pixels");
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[test]
    fn cross_volume_fallback_keeps_the_source_when_the_target_exists() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let from = src_dir.path().join("a.png");
        let to = dst_dir.path().join("a.png");
        fs::write(&from, b"source").unwrap();
        fs::write(&to, b"target").unwrap();

        assert_eq!(copy_then_remove(&from, &to), Err(FsError::Exists));
        assert_eq!(fs::read(&from).unwrap(), b"source");
        assert_eq!(fs::read(&to).unwrap(), b"target");
        assert_eq!(names_in(dst_dir.path()), vec!["a.png".to_string()]);
    }

    #[test]
    fn numbered_inserts_before_the_extension() {
        let dir = Path::new("some/dir");
        assert_eq!(
            numbered(&dir.join("武将 (立绘).png"), 2),
            dir.join("武将 (立绘) (2).png")
        );
        assert_eq!(numbered(&dir.join("a.tar.gz"), 3), dir.join("a.tar (3).gz"));
        assert_eq!(numbered(&dir.join("无扩展名"), 2), dir.join("无扩展名 (2)"));
    }

    #[test]
    fn suffixed_appends_suffix_and_number_before_the_extension() {
        let a = Path::new("a");
        assert_eq!(
            suffixed(&a.join("hero.png"), "_compressed", 1),
            a.join("hero_compressed.png")
        );
        assert_eq!(
            suffixed(&a.join("hero.png"), "_compressed", 2),
            a.join("hero_compressed_2.png")
        );
        assert_eq!(suffixed(&a.join("hero.webp"), "", 1), a.join("hero.webp"));
        assert_eq!(suffixed(&a.join("hero.webp"), "", 2), a.join("hero_2.webp"));
        assert_eq!(
            suffixed(&a.join("无扩展名"), "_x", 3),
            a.join("无扩展名_x_3")
        );
    }

    #[test]
    fn write_temp_writes_a_hidden_file_and_discard_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = write_temp(dir.path(), b"data").unwrap();
        assert_eq!(tmp.parent(), Some(dir.path()));
        assert!(
            tmp.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".glance-tmp-")
        );
        assert_eq!(fs::read(&tmp).unwrap(), b"data");
        discard_temp(&tmp);
        assert!(names_in(dir.path()).is_empty());
        // 目录不存在：报错，不留东西。
        assert_eq!(
            write_temp(&dir.path().join("missing"), b"x"),
            Err(FsError::NotFound)
        );
    }

    #[test]
    fn validate_name_rejects_bad_names() {
        for name in [
            "",
            " a",
            "a ",
            ".a",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a:b",
            "a?.png",
            "CON",
            "con.png",
            "a.",
            "a\0b",
            "a\u{1}b",
            "LPT9",
            "com1.tar.gz",
            "a<b",
            "a|b",
            "a\"b",
            "a*b",
            "a>b",
        ] {
            assert_eq!(validate_name(name), Err(FsError::InvalidName), "{name:?}");
        }
    }

    #[test]
    fn validate_name_accepts_ordinary_names() {
        for name in [
            "赵云 100%.png",
            "a (2).png",
            "a.b.c.jpg",
            "CONSOLE.png",
            "com10.png",
            "LPT.png",
        ] {
            assert_eq!(validate_name(name), Ok(()), "{name:?}");
        }
    }

    #[test]
    fn validate_name_handles_non_ascii_and_reserved_device_names() {
        for name in [
            "1张.png",
            "ab赵云.png",
            "aé.png",
            "张.png",
            "COM0",
            "COM10",
            "COMA.png",
            "CONSOLE.png",
        ] {
            assert_eq!(validate_name(name), Ok(()), "{name:?}");
        }
        for name in ["COM1", "com9.txt", "LPT1.png", "AUX", "nul.jpg"] {
            assert_eq!(validate_name(name), Err(FsError::InvalidName), "{name:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn case_only_guard_rejects_anything_but_the_same_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("x")).unwrap();
        fs::create_dir(dir.path().join("y")).unwrap();
        let a = dir.path().join("a.png");
        let b = dir.path().join("b.png");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let in_x = dir.path().join("x").join("c.png");
        let in_y = dir.path().join("y").join("C.png");
        fs::write(&in_x, b"x").unwrap();
        fs::write(&in_y, b"y").unwrap();

        assert!(!is_case_only_change(&a, &b));
        assert!(!is_case_only_change(&in_x, &in_y));
        assert!(!is_case_only_change(
            &b,
            &dir.path().join("x").join("B.png")
        ));
        assert!(!is_case_only_change(
            &a,
            &dir.path().join("x").join("missing.png")
        ));
        // 同一条目、只差大小写：不分大小写的卷上才成立。
        if dir.path().join("A.png").symlink_metadata().is_ok() {
            assert!(is_case_only_change(&a, &dir.path().join("A.png")));
        }
    }

    #[test]
    fn cross_volume_cleanup_keeps_the_copy_when_the_source_already_vanished() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("a.png");
        fs::write(&copy, b"pixels").unwrap();
        let gone = std::io::Error::from(std::io::ErrorKind::NotFound);

        assert_eq!(after_source_removal(Err(gone), &copy), Ok(()));
        assert_eq!(fs::read(&copy).unwrap(), b"pixels");
    }

    #[test]
    fn cross_volume_cleanup_removes_the_copy_when_the_source_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("a.png");
        fs::write(&copy, b"pixels").unwrap();
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);

        assert_eq!(
            after_source_removal(Err(denied), &copy),
            Err(FsError::Denied)
        );
        assert!(copy.symlink_metadata().is_err());
    }

    #[test]
    fn exdev_is_recognised_as_cross_device() {
        #[cfg(unix)]
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
        assert!(is_cross_device(&std::io::Error::from(
            std::io::ErrorKind::CrossesDevices
        )));
        assert!(!is_cross_device(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
    }

    #[test]
    fn io_errors_map_to_codes() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            FsError::from(&Error::from(ErrorKind::PermissionDenied)),
            FsError::Denied
        );
        assert_eq!(
            FsError::from(&Error::from(ErrorKind::NotFound)),
            FsError::NotFound
        );
        assert_eq!(
            FsError::from(&Error::from(ErrorKind::AlreadyExists)),
            FsError::Exists
        );
        assert_eq!(
            FsError::from(&Error::from(ErrorKind::Interrupted)),
            FsError::Other
        );
        #[cfg(unix)]
        {
            assert_eq!(
                FsError::from(&Error::from_raw_os_error(28)),
                FsError::DiskFull
            );
            assert_eq!(
                FsError::from(&Error::from_raw_os_error(30)),
                FsError::ReadOnly
            );
        }
    }

    #[test]
    fn fs_error_serializes_as_a_camel_case_string() {
        assert_eq!(
            serde_json::to_string(&FsError::DiskFull).unwrap(),
            "\"diskFull\""
        );
        assert_eq!(
            serde_json::to_string(&FsError::RestoreDenied).unwrap(),
            "\"restoreDenied\""
        );
    }
}
