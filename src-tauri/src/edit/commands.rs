//! 编辑命令。读文件、解码、编码都不在主线程：打开在阻塞线程池上做，预览在会话线程上算，
//! 命令只在阻塞线程池上等应答。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use glance_imaging::{EditParams, OutFormat, SrcFormat};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::{EditError, EditOpened, EditState, PreviewResult};
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::session::Sessions;
use crate::fileops::edit_save::{SaveTarget, save_bytes};
use crate::fileops::fsx::{FsError, validate_name};
use crate::fileops::undo::{OpKind, UndoLog};
use crate::state::session::{EditParamsMemory, SessionStore};

/// 打开编辑会话（先关旧的）。动图返回 `Animated`，不建会话。
#[tauri::command]
pub async fn edit_open(
    id: u32,
    registry: State<'_, Arc<Registry>>,
    edit: State<'_, Arc<EditState>>,
) -> Result<EditOpened, EditError> {
    let (registry, edit) = (registry.inner().clone(), edit.inner().clone());
    tauri::async_runtime::spawn_blocking(move || edit.open(&registry, FileId(id)))
        .await
        .map_err(|_| EditError::Decode)?
}

/// 请求一次预览；被更新的请求取代或会话已关时返回 `None`。
#[tauri::command]
pub async fn edit_preview(
    session: u32,
    rev: u32,
    params: EditParams,
    full: bool,
    edit: State<'_, Arc<EditState>>,
) -> Result<Option<PreviewResult>, EditError> {
    let rx = edit.submit(session, rev, params, full)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Ok(None)))
        .await
        .map_err(|_| EditError::Encode)?
}

/// 取色：坐标为转正后的全尺寸像素，在原图上取。读像素不重，但仍放进阻塞线程池，不占异步工作线程。
#[tauri::command]
pub async fn edit_pick(
    session: u32,
    x: u32,
    y: u32,
    edit: State<'_, Arc<EditState>>,
) -> Result<[u8; 3], EditError> {
    let edit = edit.inner().clone();
    tauri::async_runtime::spawn_blocking(move || edit.pick(session, x, y))
        .await
        .map_err(|_| EditError::Encode)?
}

/// 关闭编辑会话；会话号不是当前会话时什么也不做。释放大块内存，不在主线程上做。
#[tauri::command(async)]
pub fn edit_close(session: u32, edit: State<'_, Arc<EditState>>) {
    edit.close(session);
}

/// 保存方式。`SaveAs` 的路径来自系统存储对话框，原样传入，不持久化。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveMode {
    Copy,
    Overwrite,
    SaveAs { path: String },
}

/// 保存结果。`outside`：新文件不在当前打开的目录会话范围里，前端不跳转。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub id: u32,
    pub name: String,
    pub bytes: u64,
    pub token: Option<u64>,
    pub outside: bool,
}

/// 保存编辑结果。编码与写文件都在阻塞线程池上做。
#[tauri::command]
pub async fn edit_save(
    session: u32,
    params: EditParams,
    mode: SaveMode,
    app: AppHandle,
) -> Result<SaveReport, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let edit = app.state::<Arc<EditState>>();
        let registry = app.state::<Arc<Registry>>();
        let sessions = app.state::<Sessions>();
        let undo = app.state::<UndoLog>();
        run_save(&edit, &registry, &sessions, &undo, session, &params, &mode)
    })
    .await
    .map_err(|_| FsError::Other)?
}

fn fs_error(e: EditError) -> FsError {
    match e {
        EditError::NoSession | EditError::NotFound => FsError::NotFound,
        EditError::TooLarge => FsError::TooLarge,
        _ => FsError::Other,
    }
}

/// 副本后缀与输出扩展名。压缩 → `_compressed`；转格式且格式变了 → 无后缀；格式没变 → `_converted`。
/// 原扩展名已属于输出格式（如 `.jpeg`、`.JPG` 之于 JPEG）时原样保留，否则用 png / jpg / webp。
fn naming(
    src: &Path,
    src_format: SrcFormat,
    params: &EditParams,
    out: OutFormat,
) -> (String, &'static str) {
    let same_format = matches!(
        (src_format, out),
        (SrcFormat::Png, OutFormat::Png)
            | (SrcFormat::Jpeg, OutFormat::Jpeg)
            | (SrcFormat::Webp, OutFormat::Webp)
    );
    let suffix = match params {
        EditParams::Compress { .. } => "_compressed",
        EditParams::Crop { .. } => "_cropped",
        EditParams::RemoveBg(_) => "_nobg",
        EditParams::Convert { .. } if same_format => "_converted",
        EditParams::Convert { .. } => "",
    };
    let (canonical, family): (&str, &[&str]) = match out {
        OutFormat::Png => ("png", &["png"]),
        OutFormat::Jpeg => ("jpg", &["jpg", "jpeg"]),
        OutFormat::Webp => ("webp", &["webp"]),
    };
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .filter(|e| family.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or_else(|| canonical.to_string());
    (ext, suffix)
}

/// 另存的目标：必须是绝对路径、名字合法；所在目录规范化（与会话根的写法一致），不存在 → NotFound。
fn save_as_path(path: &str) -> Result<PathBuf, FsError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(FsError::InvalidName);
    }
    let name = path.file_name().ok_or(FsError::InvalidName)?;
    validate_name(&name.to_string_lossy())?;
    let dir = path.parent().ok_or(FsError::InvalidName)?;
    Ok(canonical_dir(dir)?.join(name))
}

#[cfg(not(windows))]
fn canonical_dir(dir: &Path) -> Result<PathBuf, FsError> {
    std::fs::canonicalize(dir).map_err(|_| FsError::NotFound)
}

/// Windows 上会话根不做规范化，目标目录也照原样用。（未在本机编译）
#[cfg(windows)]
fn canonical_dir(dir: &Path) -> Result<PathBuf, FsError> {
    Ok(dir.to_path_buf())
}

/// 保存的主体：取全尺寸结果（参数相同则复用或等进行中的那次，否则现算）、按方式落盘、记撤销、投提示、登记新文件。
/// 在调用方线程上编码与写文件，调用方不得是主线程。
pub fn run_save(
    edit: &EditState,
    registry: &Registry,
    sessions: &Sessions,
    undo: &UndoLog,
    session: u32,
    params: &EditParams,
    mode: &SaveMode,
) -> Result<SaveReport, FsError> {
    let (id, src_format) = edit.source(session).map_err(fs_error)?;
    let src = registry.path(id).ok_or(FsError::NotFound)?;
    let target = match mode {
        SaveMode::Copy => SaveTarget::Copy,
        SaveMode::Overwrite => SaveTarget::Overwrite,
        SaveMode::SaveAs { path } => SaveTarget::SaveAs(save_as_path(path)?),
    };
    // 参数相同的结果已有则复用，正在算则等它，都没有才现算。
    let enc = edit.compute_full(session, params).map_err(fs_error)?;
    let (ext, suffix) = naming(&src, src_format, params, enc.format);
    let out = save_bytes(&src, &enc.bytes, &ext, suffix, &target)?;
    let token = undo.record(OpKind::Edit, out.steps);
    if !out.hints.is_empty() {
        sessions.hint(out.hints);
    }
    let new_id = registry.register(&out.path);
    Ok(SaveReport {
        id: new_id.0,
        name: out
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        bytes: enc.bytes.len() as u64,
        token,
        outside: !sessions.contains(&out.path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::reconcile::FsHint;
    use crate::catalog::watch::SessionMsg;
    use glance_imaging::{PngMode, RgbaView, encode_png_lossless};
    use std::fs;
    use std::sync::mpsc::{Receiver, channel};

    struct World {
        _dir: tempfile::TempDir,
        root: PathBuf,
        registry: Registry,
        sessions: Sessions,
        undo: UndoLog,
        edit: EditState,
        rx: Receiver<SessionMsg>,
        session: u32,
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w) as u8, (i / w) as u8, 90, 255])
            .collect();
        encode_png_lossless(
            RgbaView {
                width: w,
                height: h,
                data: &data,
            },
            None,
        )
        .unwrap()
    }

    /// 以临时目录为根（不含子目录）的目录会话，根下一张 hero.png，并打开编辑会话。
    fn world() -> World {
        world_with("hero.png", &png_bytes(64, 48))
    }

    fn world_with(name: &str, bytes: &[u8]) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let sessions = Sessions::default();
        let (tx, rx) = channel();
        sessions.note(1);
        let (g, _) = sessions.begin(1).unwrap();
        sessions.attach_scoped(g, root.clone(), false, tx);
        let registry = Registry::default();
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        let edit = EditState::default();
        let session = edit
            .open(&registry, registry.register(&path))
            .unwrap()
            .session;
        World {
            _dir: dir,
            root,
            registry,
            sessions,
            undo: UndoLog::default(),
            edit,
            rx,
            session,
        }
    }

    impl World {
        fn save(&self, params: &EditParams, mode: SaveMode) -> Result<SaveReport, FsError> {
            run_save(
                &self.edit,
                &self.registry,
                &self.sessions,
                &self.undo,
                self.session,
                params,
                &mode,
            )
        }

        fn hints(&self) -> Vec<Vec<FsHint>> {
            self.rx
                .try_iter()
                .filter_map(|m| match m {
                    SessionMsg::Hints(h) => Some(h),
                    SessionMsg::Watch(_) => None,
                })
                .collect()
        }
    }

    fn compress() -> EditParams {
        EditParams::Compress {
            quality: 80,
            max_edge: None,
            png_mode: PngMode::Lossless,
        }
    }

    fn convert(format: OutFormat) -> EditParams {
        EditParams::Convert {
            format,
            quality: 85,
            fill: [255; 3],
        }
    }

    #[test]
    fn report_marks_outside_session() {
        let w = world();
        let r = w.save(&compress(), SaveMode::Copy).unwrap();
        let path = w.root.join("hero_compressed.png");
        assert_eq!(r.name, "hero_compressed.png");
        assert_eq!(FileId(r.id), w.registry.register(&path));
        assert_eq!(r.bytes, fs::metadata(&path).unwrap().len());
        assert!(!r.outside);
        assert!(r.token.is_some());
        assert_eq!(w.hints(), vec![vec![FsHint::Touched(path.clone())]]);
        let entry = w.undo.take().unwrap();
        assert_eq!(entry.kind, OpKind::Edit);
        assert_eq!(entry.token, r.token.unwrap());

        // 另存到会话外的目录：outside。目录写法不规范（经符号链接等）也按规范路径登记。
        let other = tempfile::tempdir().unwrap();
        let to = other.path().join("out.webp");
        let r = w
            .save(
                &convert(OutFormat::Webp),
                SaveMode::SaveAs {
                    path: to.to_string_lossy().into_owned(),
                },
            )
            .unwrap();
        assert!(r.outside);
        assert_eq!(r.name, "out.webp");
        // 与保存时同一规则（Windows 上不规范化，fs::canonicalize 会加 \\?\ 前缀）
        let canonical = canonical_dir(other.path()).unwrap().join("out.webp");
        assert_eq!(w.registry.path(FileId(r.id)), Some(canonical));

        // 另存到根的子目录：会话不含子目录 → 也算 outside。
        fs::create_dir(w.root.join("sub")).unwrap();
        let r = w
            .save(
                &compress(),
                SaveMode::SaveAs {
                    path: w.root.join("sub/x.png").to_string_lossy().into_owned(),
                },
            )
            .unwrap();
        assert!(r.outside);
    }

    #[test]
    fn copy_names_follow_operation_and_format() {
        let w = world();
        assert_eq!(
            w.save(&convert(OutFormat::Jpeg), SaveMode::Copy)
                .unwrap()
                .name,
            "hero.jpg"
        );
        assert_eq!(
            w.save(&convert(OutFormat::Png), SaveMode::Copy)
                .unwrap()
                .name,
            "hero_converted.png"
        );
        assert_eq!(
            w.save(&compress(), SaveMode::Copy).unwrap().name,
            "hero_compressed.png"
        );
        assert_eq!(
            w.save(&compress(), SaveMode::Copy).unwrap().name,
            "hero_compressed_2.png"
        );
        // 写进去的就是全尺寸结果。
        let enc = w.edit.compute_full(w.session, &compress()).unwrap();
        assert_eq!(
            fs::read(w.root.join("hero_compressed_2.png")).unwrap(),
            enc.bytes
        );
    }

    #[test]
    fn naming_keeps_jpeg_family_extension() {
        let q = |src: &str, f: SrcFormat, p: EditParams, out: OutFormat| {
            naming(Path::new(src), f, &p, out)
        };
        assert_eq!(
            q("a/p.jpeg", SrcFormat::Jpeg, compress(), OutFormat::Jpeg),
            ("jpeg".into(), "_compressed")
        );
        assert_eq!(
            q(
                "a/P.JPG",
                SrcFormat::Jpeg,
                convert(OutFormat::Jpeg),
                OutFormat::Jpeg
            ),
            ("JPG".into(), "_converted")
        );
        assert_eq!(
            q(
                "a/p.png",
                SrcFormat::Png,
                convert(OutFormat::Jpeg),
                OutFormat::Jpeg
            ),
            ("jpg".into(), "")
        );
        assert_eq!(
            q(
                "a/p.gif",
                SrcFormat::Gif,
                convert(OutFormat::Png),
                OutFormat::Png
            ),
            ("png".into(), "")
        );
        assert_eq!(
            q(
                "a/p.jpeg",
                SrcFormat::Jpeg,
                convert(OutFormat::Webp),
                OutFormat::Webp
            ),
            ("webp".into(), "")
        );
    }

    #[test]
    fn save_errors() {
        let w = world();
        let rel = SaveMode::SaveAs {
            path: "relative/x.png".into(),
        };
        assert_eq!(w.save(&compress(), rel), Err(FsError::InvalidName));
        let missing = SaveMode::SaveAs {
            path: w.root.join("nope/x.png").to_string_lossy().into_owned(),
        };
        assert_eq!(w.save(&compress(), missing), Err(FsError::NotFound));
        let taken = SaveMode::SaveAs {
            path: w.root.join("hero.png").to_string_lossy().into_owned(),
        };
        assert_eq!(w.save(&compress(), taken), Err(FsError::Exists));
        // 失败不记撤销、不投提示。
        assert!(w.undo.take().is_none());
        assert!(w.hints().is_empty());
        w.edit.close(w.session);
        assert_eq!(w.save(&compress(), SaveMode::Copy), Err(FsError::NotFound));
        assert_eq!(fs::read_dir(&w.root).unwrap().count(), 1);
    }

    #[test]
    fn save_mode_deserializes() {
        let m: SaveMode = serde_json::from_str(r#"{"kind":"copy"}"#).unwrap();
        assert_eq!(m, SaveMode::Copy);
        let m: SaveMode = serde_json::from_str(r#"{"kind":"overwrite"}"#).unwrap();
        assert_eq!(m, SaveMode::Overwrite);
        let m: SaveMode = serde_json::from_str(r#"{"kind":"saveAs","path":"/x/a.png"}"#).unwrap();
        assert_eq!(
            m,
            SaveMode::SaveAs {
                path: "/x/a.png".into()
            }
        );
    }
    fn crop_params() -> EditParams {
        EditParams::Crop {
            rect: glance_imaging::CropRect {
                x: 0,
                y: 0,
                w: 10,
                h: 10,
            },
            quarter_turns: 0,
            flip_h: false,
            flip_v: false,
        }
    }

    fn crop_1x1() -> EditParams {
        EditParams::Crop {
            rect: glance_imaging::CropRect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            quarter_turns: 0,
            flip_h: false,
            flip_v: false,
        }
    }

    fn nobg() -> EditParams {
        EditParams::RemoveBg(glance_imaging::RemoveBg::Color {
            color: [0, 0, 0],
            tolerance: 30,
            softness: 0,
            edge_connected: false,
        })
    }

    fn jpeg_bytes() -> Vec<u8> {
        let data = vec![200u8; 32 * 32 * 4];
        glance_imaging::encode_jpeg(
            RgbaView {
                width: 32,
                height: 32,
                data: &data,
            },
            90,
            [255; 3],
            None,
        )
        .unwrap()
    }

    #[test]
    fn crop_and_nobg_copy_names() {
        let w = world();
        assert_eq!(
            w.save(&crop_params(), SaveMode::Copy).unwrap().name,
            "hero_cropped.png"
        );
        assert_eq!(
            w.save(&crop_params(), SaveMode::Copy).unwrap().name,
            "hero_cropped_2.png"
        );
        let c = decode_size(&fs::read(w.root.join("hero_cropped.png")).unwrap());
        assert_eq!(c, (10, 10));

        let w = world_with("photo.jpg", &jpeg_bytes());
        assert_eq!(
            w.save(&nobg(), SaveMode::Copy).unwrap().name,
            "photo_nobg.png"
        );

        // 静态 GIF 裁剪：输出 PNG。
        let w = world_with("anim.gif", &crate::catalog::details::testimg::gif(1));
        assert_eq!(
            w.save(&crop_1x1(), SaveMode::Copy).unwrap().name,
            "anim_cropped.png"
        );
    }

    fn decode_size(b: &[u8]) -> (u32, u32) {
        let d = glance_imaging::decode_rgba(b, u64::MAX).unwrap();
        (d.width, d.height)
    }

    #[test]
    fn alpha_remove_bg_save_on_opaque_source_is_refused() {
        let w = world();
        let p = EditParams::RemoveBg(glance_imaging::RemoveBg::Alpha {
            threshold: 10,
            below: true,
        });
        assert_eq!(w.save(&p, SaveMode::Copy), Err(FsError::Other));
        assert_eq!(fs::read_dir(&w.root).unwrap().count(), 1);
    }

    #[test]
    #[ignore = "覆盖原图会把文件移进真实废纸篓（只动本测试临时目录里的文件）"]
    fn nobg_overwrite_jpg_source_writes_png_and_undo_restores() {
        let w = world_with("photo.jpg", &jpeg_bytes());
        let orig = fs::read(w.root.join("photo.jpg")).unwrap();
        let r = w.save(&nobg(), SaveMode::Overwrite).unwrap();
        assert_eq!(r.name, "photo.png");
        assert!(!w.root.join("photo.jpg").exists());
        assert!(w.root.join("photo.png").exists());
        let entry = w.undo.take().unwrap();
        let undone = crate::fileops::ops::undo(&entry.steps);
        assert!(undone.failed.is_empty(), "{:?}", undone.failed);
        assert_eq!(fs::read(w.root.join("photo.jpg")).unwrap(), orig);
        assert!(!w.root.join("photo.png").exists());
    }
}

/// 读上次记住的编辑参数（内存副本，不碰磁盘）。
#[tauri::command]
pub fn edit_params_get(store: State<'_, Arc<SessionStore>>) -> EditParamsMemory {
    store.edit_params()
}

/// 记住编辑参数；写盘，不上主线程。
#[tauri::command]
pub async fn edit_params_set(
    p: EditParamsMemory,
    store: State<'_, Arc<SessionStore>>,
) -> Result<(), ()> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.set_edit_params(p))
        .await
        .map_err(|_| ())
}
