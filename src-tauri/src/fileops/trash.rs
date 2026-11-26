//! 移入系统废纸篓与放回。撤销日志用放回来撤回删除。

use std::path::{Path, PathBuf};

use super::fsx::FsError;

/// 放回所需的全部信息。撤销日志的放回步骤（`Step::Restore`）带着它。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TrashHandle {
    pub original: PathBuf,
    /// macOS：文件在废纸篓里的位置。Windows：回收站项的标识（`TrashItem::id`），
    /// 没找到时为 None，放回时退回按 original 查找。
    pub trashed_at: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum TrashError {
    #[error("文件不存在：{0}")]
    NotFound(PathBuf),
    #[error("原位置已有同名文件：{0}")]
    Occupied(PathBuf),
    #[error("废纸篓里找不到该文件：{0}")]
    NotInTrash(PathBuf),
    #[error("系统拒绝访问废纸篓")]
    Denied,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// 移入废纸篓时的错误归类。
impl From<TrashError> for FsError {
    fn from(err: TrashError) -> Self {
        match err {
            TrashError::NotFound(_) => FsError::NotFound,
            TrashError::Occupied(_) => FsError::Exists,
            TrashError::NotInTrash(_) => FsError::NotInTrash,
            TrashError::Denied => FsError::Denied,
            TrashError::Io(e) => FsError::from(&e),
        }
    }
}

impl TrashError {
    /// 放回时的错误归类：系统拒绝放回要提示用户手动恢复，单独成一类。
    pub fn into_restore_error(self) -> FsError {
        match self {
            TrashError::Denied => FsError::RestoreDenied,
            other => FsError::from(other),
        }
    }
}

fn exists_no_follow(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

pub fn move_to_trash(path: &Path) -> Result<TrashHandle, TrashError> {
    if !exists_no_follow(path) {
        return Err(TrashError::NotFound(path.to_path_buf()));
    }
    platform::move_to_trash(path)
}

/// 移入废纸篓且不需要放回（撤销步骤里把输出文件扔掉）。Windows 上省去两次列举回收站。
pub fn discard(path: &Path) -> Result<(), TrashError> {
    if !exists_no_follow(path) {
        return Err(TrashError::NotFound(path.to_path_buf()));
    }
    platform::discard(path)
}

pub fn restore(handle: &TrashHandle) -> Result<(), TrashError> {
    if exists_no_follow(&handle.original) {
        return Err(TrashError::Occupied(handle.original.clone()));
    }
    platform::restore(handle)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{TrashError, TrashHandle};
    use crate::fileops::fsx::rename_noreplace_io;
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};

    /// NSCocoaErrorDomain 里的"无写权限"。
    const NS_FILE_WRITE_NO_PERMISSION: isize = 513;

    pub fn move_to_trash(path: &Path) -> Result<TrashHandle, TrashError> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let manager = NSFileManager::defaultManager();
        let mut resulting: Option<objc2::rc::Retained<NSURL>> = None;
        manager
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
            .map_err(|err| {
                if err.code() == NS_FILE_WRITE_NO_PERMISSION {
                    TrashError::Denied
                } else {
                    TrashError::Io(std::io::Error::other(
                        err.localizedDescription().to_string(),
                    ))
                }
            })?;
        let trashed_at = resulting
            .and_then(|u| u.path())
            .map(|p| PathBuf::from(p.to_string()));
        Ok(TrashHandle {
            original: path.to_path_buf(),
            trashed_at,
        })
    }

    pub fn discard(path: &Path) -> Result<(), TrashError> {
        move_to_trash(path).map(|_| ())
    }

    pub fn restore(handle: &TrashHandle) -> Result<(), TrashError> {
        let trashed = handle
            .trashed_at
            .as_ref()
            .ok_or_else(|| TrashError::NotInTrash(handle.original.clone()))?;
        if trashed.symlink_metadata().is_err() {
            return Err(TrashError::NotInTrash(trashed.clone()));
        }
        rename_noreplace_io(trashed, &handle.original).map_err(|e| {
            if e.raw_os_error() == Some(libc::EEXIST) {
                TrashError::Occupied(handle.original.clone())
            } else if e.kind() == ErrorKind::PermissionDenied {
                TrashError::Denied
            } else {
                TrashError::Io(e)
            }
        })
    }
}

// 未在本机编译或测试过（本机为 macOS）；由 CI 的 Windows 任务跑 trash_roundtrip 验证。
#[cfg(windows)]
mod platform {
    use super::{TrashError, TrashHandle};
    use std::collections::HashSet;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn map(err: trash::Error) -> TrashError {
        match err {
            trash::Error::RestoreCollision { path, .. } => TrashError::Occupied(path),
            other => TrashError::Io(std::io::Error::other(other.to_string())),
        }
    }

    /// 回收站里与该文件同名的项。
    fn same_name(path: &Path) -> Result<Vec<trash::TrashItem>, TrashError> {
        let name = path.file_name().unwrap_or_default();
        Ok(trash::os_limited::list()
            .map_err(map)?
            .into_iter()
            .filter(|item| item.name.as_os_str() == name)
            .collect())
    }

    /// 移入回收站，并记下这一项在回收站里的标识（`TrashItem::id`）。
    /// 同一路径先后进回收站多次时（覆盖保存：先原图、撤销时再进编辑后的版本），
    /// 放回只认这个标识，不按原路径取最新一项。
    pub fn move_to_trash(path: &Path) -> Result<TrashHandle, TrashError> {
        let before: HashSet<OsString> = same_name(path)?.into_iter().map(|i| i.id).collect();
        trash::delete(path).map_err(map)?;
        let fresh: Vec<trash::TrashItem> = same_name(path)?
            .into_iter()
            .filter(|item| !before.contains(&item.id))
            .collect();
        let pick = fresh
            .iter()
            .filter(|item| item.original_path() == path)
            .max_by_key(|item| item.time_deleted)
            .or_else(|| fresh.iter().max_by_key(|item| item.time_deleted));
        Ok(TrashHandle {
            original: path.to_path_buf(),
            trashed_at: pick.map(|item| PathBuf::from(&item.id)),
        })
    }

    pub fn discard(path: &Path) -> Result<(), TrashError> {
        trash::delete(path).map_err(map)
    }

    pub fn restore(handle: &TrashHandle) -> Result<(), TrashError> {
        let items = trash::os_limited::list().map_err(map)?;
        let item = match &handle.trashed_at {
            Some(id) => items
                .into_iter()
                .find(|item| Path::new(&item.id) == id.as_path()),
            // 没记到标识（移入后没在回收站里找到新项）：退回按原路径取最新一项。
            None => items
                .into_iter()
                .filter(|item| item.original_path() == handle.original)
                .max_by_key(|item| item.time_deleted),
        }
        .ok_or_else(|| TrashError::NotInTrash(handle.original.clone()))?;
        trash::os_limited::restore_all([item]).map_err(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trash_errors_map_to_codes() {
        let p = || PathBuf::from("a.png");
        assert_eq!(FsError::from(TrashError::NotFound(p())), FsError::NotFound);
        assert_eq!(FsError::from(TrashError::Occupied(p())), FsError::Exists);
        assert_eq!(
            FsError::from(TrashError::NotInTrash(p())),
            FsError::NotInTrash
        );
        assert_eq!(FsError::from(TrashError::Denied), FsError::Denied);
        assert_eq!(
            FsError::from(TrashError::Io(std::io::ErrorKind::PermissionDenied.into())),
            FsError::Denied
        );
        assert_eq!(
            TrashError::Denied.into_restore_error(),
            FsError::RestoreDenied
        );
        assert_eq!(
            TrashError::Occupied(p()).into_restore_error(),
            FsError::Exists
        );
        assert_eq!(
            TrashError::NotInTrash(p()).into_restore_error(),
            FsError::NotInTrash
        );
    }
}
