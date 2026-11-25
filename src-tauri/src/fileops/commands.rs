//! 面向界面的文件操作与撤销命令。命令本身只取出状态，主体在不依赖 tauri 的 `run_*` 函数里。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::fsx::FsError;
use super::ops::{self, Conflict};
use super::undo::{OpKind, Step, UndoLog};
use crate::catalog::registry::{FileId, Registry};
use crate::catalog::session::Sessions;
use crate::state::session::SessionStore;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub id: u32,
    pub code: FsError,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpReport {
    pub kind: OpKind,
    pub done: Vec<u32>,       // 成功的 id，保持输入顺序
    pub failed: Vec<Failure>, // 未登记的 id 记为 NotFound
    pub token: Option<u64>,   // 可撤销时给出
    pub dest: Option<String>, // 移动 / 复制：目标目录的完整路径（显示用）
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Dest {
    Path { path: String },     // 选目录对话框或最近目标给出的路径
    NewChild { name: String }, // 在当前根目录下新建（或复用）这个名字的子目录
    Dir { dir: String },       // 当前根目录下已存在的目录，以 `/` 分隔的相对写法；"" 是根目录本身
}

/// kind 为 None 表示没有可撤销的操作。
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub kind: Option<OpKind>,
    pub done: usize,
    pub failed: Vec<UndoFailure>,
}

/// 撤销失败的一步。name 只是那一步所针对文件的名字（最后一级），不是路径。
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoFailure {
    pub name: String,
    pub code: FsError,
}

const RECENT_LIMIT: usize = 5;

/// 最近用过的目标目录，最新的在前，最多 5 个；持久化交给 `SessionStore`。
pub struct RecentTargets {
    list: Mutex<Vec<String>>,
    store: Arc<SessionStore>,
}

impl RecentTargets {
    /// 取 `store` 里已有的最近目标；丢掉空串，最多留 5 个。
    pub fn new(store: Arc<SessionStore>) -> Self {
        let mut list: Vec<String> = store
            .recent_targets()
            .into_iter()
            .filter(|d| !d.is_empty())
            .collect();
        list.truncate(RECENT_LIMIT);
        Self {
            list: Mutex::new(list),
            store,
        }
    }

    fn remember(&self, dir: String) {
        let mut list = self.list.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|d| *d != dir);
        list.insert(0, dir);
        list.truncate(RECENT_LIMIT);
        self.store.set_recent_targets(list.clone());
    }

    pub fn list(&self) -> Vec<String> {
        self.list.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[tauri::command(async)]
pub fn fs_trash(
    ids: Vec<u32>,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    undo: State<'_, UndoLog>,
) -> OpReport {
    run_trash(&registry, &sessions, &undo, &ids)
}

#[tauri::command(async)]
pub fn fs_rename(
    id: u32,
    name: String,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    undo: State<'_, UndoLog>,
) -> OpReport {
    run_rename(&registry, &sessions, &undo, id, &name)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn fs_move(
    ids: Vec<u32>,
    dest: Dest,
    conflict: Conflict,
    extend: Option<u64>,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    undo: State<'_, UndoLog>,
    recents: State<'_, RecentTargets>,
) -> OpReport {
    let ctx = Ctx {
        registry: &registry,
        sessions: &sessions,
        undo: &undo,
        recents: &recents,
    };
    run_transfer(&ctx, OpKind::Move, &ids, &dest, conflict, extend)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn fs_copy(
    ids: Vec<u32>,
    dest: Dest,
    conflict: Conflict,
    extend: Option<u64>,
    registry: State<'_, Arc<Registry>>,
    sessions: State<'_, Sessions>,
    undo: State<'_, UndoLog>,
    recents: State<'_, RecentTargets>,
) -> OpReport {
    let ctx = Ctx {
        registry: &registry,
        sessions: &sessions,
        undo: &undo,
        recents: &recents,
    };
    run_transfer(&ctx, OpKind::Copy, &ids, &dest, conflict, extend)
}

#[tauri::command(async)]
pub fn fs_undo(sessions: State<'_, Sessions>, undo: State<'_, UndoLog>) -> UndoReport {
    run_undo(&sessions, &undo)
}

#[tauri::command(async)]
pub fn fs_recent_targets(recents: State<'_, RecentTargets>) -> Vec<String> {
    recents.list()
}

/// 移动 / 复制要用到的全部状态。
pub struct Ctx<'a> {
    pub registry: &'a Registry,
    pub sessions: &'a Sessions,
    pub undo: &'a UndoLog,
    pub recents: &'a RecentTargets,
}

pub fn run_trash(
    registry: &Registry,
    sessions: &Sessions,
    undo: &UndoLog,
    ids: &[u32],
) -> OpReport {
    let lookup = Lookup::new(registry, ids);
    let outcome = ops::trash(&lookup.paths());
    finish(
        sessions,
        undo,
        OpKind::Trash,
        &lookup,
        outcome,
        Vec::new(),
        None,
        None,
    )
}

pub fn run_rename(
    registry: &Registry,
    sessions: &Sessions,
    undo: &UndoLog,
    id: u32,
    name: &str,
) -> OpReport {
    let lookup = Lookup::new(registry, &[id]);
    let outcome = match lookup.paths().first() {
        Some(path) => ops::rename(path, name),
        None => ops::Outcome::default(),
    };
    finish(
        sessions,
        undo,
        OpKind::Rename,
        &lookup,
        outcome,
        Vec::new(),
        None,
        None,
    )
}

/// 移动或复制（kind 只能是 Move 或 Copy）。
pub fn run_transfer(
    ctx: &Ctx,
    kind: OpKind,
    ids: &[u32],
    dest: &Dest,
    conflict: Conflict,
    extend: Option<u64>,
) -> OpReport {
    let lookup = Lookup::new(ctx.registry, ids);
    let (dest_dir, made) = match resolve_dest(ctx.sessions, dest) {
        Ok(resolved) => resolved,
        Err(code) => return lookup.fail_all(kind, code),
    };
    let outcome = ops::transfer(kind, &lookup.paths(), &dest_dir, conflict);
    let any_done = outcome.items.iter().any(Result::is_ok);

    // 新建目录的撤销步骤排在最前：撤销倒序执行，于是最后才删目录。
    let mut lead = Vec::new();
    let mut removed = false;
    if let Some(step) = made {
        if any_done {
            lead.push(step);
        } else {
            // 一个都没成功：刚建的空目录立刻删掉。删不掉时它还在，照常报告。
            removed = std::fs::remove_dir(&dest_dir).is_ok();
        }
    }
    let dest_str = dest_dir.to_string_lossy().into_owned();
    if any_done {
        ctx.recents.remember(dest_str.clone());
    }
    let shown = (!removed).then_some(dest_str);
    finish(
        ctx.sessions,
        ctx.undo,
        kind,
        &lookup,
        outcome,
        lead,
        extend,
        shown,
    )
}

pub fn run_undo(sessions: &Sessions, undo: &UndoLog) -> UndoReport {
    let Some(entry) = undo.take() else {
        return UndoReport {
            kind: None,
            done: 0,
            failed: Vec::new(),
        };
    };
    let outcome = ops::undo(&entry.steps);
    send_hints(sessions, outcome.hints);
    UndoReport {
        kind: Some(entry.kind),
        done: outcome.done,
        failed: outcome
            .failed
            .into_iter()
            .map(|(path, code)| UndoFailure {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                code,
            })
            .collect(),
    }
}

/// 目标目录，以及新建目录时的撤销步骤。
fn resolve_dest(sessions: &Sessions, dest: &Dest) -> Result<(PathBuf, Option<Step>), FsError> {
    match dest {
        Dest::Path { path } => {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                Ok((canonical_dest(path)?, None))
            } else {
                Err(FsError::InvalidName)
            }
        }
        Dest::NewChild { name } => {
            super::fsx::validate_name(name)?;
            let root = sessions.root().ok_or(FsError::NotFound)?;
            ops::make_dir(&root, name)
        }
        Dest::Dir { dir } => {
            let root = sessions.root().ok_or(FsError::NotFound)?;
            Ok((resolve_rel_dir(&root, dir)?, None))
        }
    }
}

/// 根目录下已存在的相对目录。每一段必须恰好是一个普通名字（空段、`.`、`..`、带根或盘符的都不行）；
/// 不新建目录，也不做规范化（根目录本身已是规范路径）。
fn resolve_rel_dir(root: &Path, dir: &str) -> Result<PathBuf, FsError> {
    if dir.is_empty() {
        return Ok(root.to_path_buf());
    }
    let mut path = root.to_path_buf();
    for segment in dir.split('/') {
        let mut parts = Path::new(segment).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(name)), None) => path.push(name),
            _ => return Err(FsError::InvalidName),
        }
    }
    if path.is_dir() {
        Ok(path)
    } else {
        Err(FsError::NotFound)
    }
}

/// 会话根在 macOS 上是规范化的路径（见 catalog::session）；目标目录也要规范化，否则经由符号链接
/// 写法移进根下的子目录时，提示里的路径落在根外，条目会被删掉再以新 id 加回。
/// 解析失败（多半是目录不存在）→ NotFound。
#[cfg(not(windows))]
fn canonical_dest(path: PathBuf) -> Result<PathBuf, FsError> {
    std::fs::canonicalize(&path).map_err(|_| FsError::NotFound)
}

/// Windows 上会话根不做规范化（规范化会加 `\\?\` 前缀），目标目录也照原样用。（未在本机编译）
#[cfg(windows)]
fn canonical_dest(path: PathBuf) -> Result<PathBuf, FsError> {
    Ok(path)
}

/// 输入的 id 去重（只留第一次出现）后逐个换成路径。
struct Lookup {
    ids: Vec<u32>,
    paths: Vec<Option<PathBuf>>,
}

impl Lookup {
    fn new(registry: &Registry, ids: &[u32]) -> Self {
        let mut seen = HashSet::new();
        let ids: Vec<u32> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
        let paths = ids.iter().map(|id| registry.path(FileId(*id))).collect();
        Self { ids, paths }
    }

    /// 已登记的路径，按输入顺序；交给 ops 的就是它，结果与之一一对应。
    fn paths(&self) -> Vec<PathBuf> {
        self.paths.iter().flatten().cloned().collect()
    }

    fn fail_all(&self, kind: OpKind, code: FsError) -> OpReport {
        OpReport {
            kind,
            done: Vec::new(),
            failed: self
                .ids
                .iter()
                .map(|&id| Failure {
                    id,
                    code: code.clone(),
                })
                .collect(),
            token: None,
            dest: None,
        }
    }
}

/// 记撤销、投提示、组装报告。lead 是排在本次步骤之前的步骤（新建的目录）。
#[allow(clippy::too_many_arguments)]
fn finish(
    sessions: &Sessions,
    undo: &UndoLog,
    kind: OpKind,
    lookup: &Lookup,
    outcome: ops::Outcome,
    mut lead: Vec<Step>,
    extend: Option<u64>,
    dest: Option<String>,
) -> OpReport {
    let mut done = Vec::new();
    let mut failed = Vec::new();
    let mut items = outcome.items.into_iter();
    for (&id, path) in lookup.ids.iter().zip(&lookup.paths) {
        // 未登记的 id 不交给 ops，没有对应结果；ops 对其余每项都给出一个结果。
        let result = match path {
            Some(_) => items.next().unwrap_or(Err(FsError::Other)),
            None => Err(FsError::NotFound),
        };
        match result {
            Ok(_) => done.push(id),
            Err(code) => failed.push(Failure { id, code }),
        }
    }
    lead.extend(outcome.steps);
    let token = remember_undo(undo, kind, lead, extend);
    send_hints(sessions, outcome.hints);
    OpReport {
        kind,
        done,
        failed,
        token,
        dest,
    }
}

/// 带着仍有效的 token 时追加进原记录并沿用它，否则另记一条。没有步骤时不记，返回 None。
fn remember_undo(
    undo: &UndoLog,
    kind: OpKind,
    steps: Vec<Step>,
    extend: Option<u64>,
) -> Option<u64> {
    if steps.is_empty() {
        return None;
    }
    if let Some(token) = extend
        && undo.extend(token, steps.clone())
    {
        return Some(token);
    }
    undo.record(kind, steps)
}

fn send_hints(sessions: &Sessions, hints: Vec<crate::catalog::reconcile::FsHint>) {
    if !hints.is_empty() {
        sessions.hint(hints);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::reconcile::FsHint;
    use crate::catalog::watch::SessionMsg;
    use std::fs;
    use std::path::Path;
    use std::sync::mpsc::{Receiver, channel};

    struct World {
        _dir: tempfile::TempDir,
        root: PathBuf, // 规范化后的临时目录，与真实会话的根一致
        registry: Registry,
        sessions: Sessions,
        undo: UndoLog,
        recents: RecentTargets,
        rx: Option<Receiver<SessionMsg>>,
    }

    impl World {
        /// 带一个以临时目录为根的会话。
        fn new() -> Self {
            let mut w = Self::without_session();
            let (tx, rx) = channel();
            w.sessions.note(1);
            let (generation, _) = w.sessions.begin(1).unwrap();
            w.sessions.attach(generation, w.root(), tx);
            w.rx = Some(rx);
            w
        }

        fn without_session() -> Self {
            let dir = tempfile::tempdir().unwrap();
            Self {
                root: fs::canonicalize(dir.path()).unwrap(),
                _dir: dir,
                registry: Registry::default(),
                sessions: Sessions::default(),
                undo: UndoLog::default(),
                recents: RecentTargets::new(Arc::new(SessionStore::memory())),
                rx: None,
            }
        }

        fn root(&self) -> PathBuf {
            self.root.clone()
        }

        fn ctx(&self) -> Ctx<'_> {
            Ctx {
                registry: &self.registry,
                sessions: &self.sessions,
                undo: &self.undo,
                recents: &self.recents,
            }
        }

        /// 在根目录下写文件并登记，返回 id。
        fn file(&self, rel: &str, content: &[u8]) -> u32 {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            self.registry.register(&path).0
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn hints(&self) -> Vec<Vec<FsHint>> {
            self.rx
                .as_ref()
                .unwrap()
                .try_iter()
                .filter_map(|m| match m {
                    SessionMsg::Hints(h) => Some(h),
                    SessionMsg::Watch(_) => None,
                })
                .collect()
        }

        fn mv(&self, ids: &[u32], dest: Dest, conflict: Conflict, extend: Option<u64>) -> OpReport {
            run_transfer(&self.ctx(), OpKind::Move, ids, &dest, conflict, extend)
        }
    }

    fn to_path(p: &Path) -> Dest {
        Dest::Path {
            path: p.to_string_lossy().into_owned(),
        }
    }

    fn fail(id: u32, code: FsError) -> Failure {
        Failure { id, code }
    }

    #[test]
    fn rename_reports_done_and_sends_a_rename_hint() {
        let w = World::new();
        let a = w.file("a.png", b"a");

        let report = run_rename(&w.registry, &w.sessions, &w.undo, a, "b.png");
        assert_eq!(report.kind, OpKind::Rename);
        assert_eq!(report.done, vec![a]);
        assert!(report.failed.is_empty());
        assert!(report.token.is_some());
        assert_eq!(report.dest, None);
        assert_eq!(fs::read(w.root().join("b.png")).unwrap(), b"a");
        assert_eq!(
            w.hints(),
            vec![vec![FsHint::Renamed {
                from: w.root().join("a.png"),
                to: w.root().join("b.png")
            }]]
        );

        // 与原名相同：成功但没有可撤销的步骤，也不发提示。
        let b = w.registry.register(&w.root().join("b.png")).0;
        let same = run_rename(&w.registry, &w.sessions, &w.undo, b, "b.png");
        assert_eq!(same.done, vec![b]);
        assert_eq!(same.token, None);
        assert!(w.hints().is_empty());
    }

    #[test]
    fn unregistered_id_is_reported_as_not_found() {
        let w = World::new();
        let dest = w.mkdir("dest");
        let a = w.file("a.png", b"a");

        let renamed = run_rename(&w.registry, &w.sessions, &w.undo, 999, "x.png");
        assert_eq!(renamed.done, Vec::<u32>::new());
        assert_eq!(renamed.failed, vec![fail(999, FsError::NotFound)]);
        assert_eq!(renamed.token, None);

        // 其余的照常执行，报告保持输入顺序；重复的 id 只处理第一次。
        let moved = w.mv(&[999, a, 998, a], to_path(&dest), Conflict::Skip, None);
        assert_eq!(moved.done, vec![a]);
        assert_eq!(
            moved.failed,
            vec![fail(999, FsError::NotFound), fail(998, FsError::NotFound)]
        );
        assert!(dest.join("a.png").is_file());
    }

    #[test]
    fn move_reports_conflicts_per_id_and_remembers_the_destination() {
        let w = World::new();
        let dest = w.mkdir("dest");
        fs::write(dest.join("b.png"), b"old").unwrap();
        let a = w.file("src/a.png", b"a");
        let b = w.file("src/b.png", b"b");
        let c = w.file("src/c.png", b"c");

        let report = w.mv(&[a, b, c], to_path(&dest), Conflict::Skip, None);
        assert_eq!(report.kind, OpKind::Move);
        assert_eq!(report.done, vec![a, c]);
        assert_eq!(report.failed, vec![fail(b, FsError::Exists)]);
        assert!(report.token.is_some());
        let dest_str = dest.to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(dest_str.as_str()));
        assert_eq!(fs::read(dest.join("b.png")).unwrap(), b"old");
        assert_eq!(w.recents.list(), vec![dest_str]);
        assert_eq!(w.hints().concat().len(), 2);

        // 一项都没成功：不记入最近目标，也不给 token。
        let other = w.mkdir("other");
        fs::write(other.join("b.png"), b"other").unwrap();
        let none = w.mv(&[b], to_path(&other), Conflict::Skip, None);
        assert_eq!(none.done, Vec::<u32>::new());
        assert_eq!(none.token, None);
        assert_eq!(w.recents.list().len(), 1);
        assert!(w.hints().is_empty());
    }

    #[test]
    fn relative_destination_path_fails_every_item() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        let report = w.mv(
            &[a, 999],
            Dest::Path {
                path: "dest".into(),
            },
            Conflict::Skip,
            None,
        );
        assert_eq!(
            report.failed,
            vec![
                fail(a, FsError::InvalidName),
                fail(999, FsError::InvalidName)
            ]
        );
        assert!(w.root().join("a.png").is_file());
    }

    #[test]
    fn keep_both_with_a_live_token_extends_the_same_undo_entry() {
        let w = World::new();
        let dest = w.mkdir("dest");
        fs::write(dest.join("b.png"), b"old").unwrap();
        let a = w.file("src/a.png", b"a");
        let b = w.file("src/b.png", b"b");

        let first = w.mv(&[a, b], to_path(&dest), Conflict::Skip, None);
        let token = first.token.unwrap();
        let second = w.mv(&[b], to_path(&dest), Conflict::KeepBoth, Some(token));
        assert_eq!(second.done, vec![b]);
        assert_eq!(second.token, Some(token));
        assert_eq!(fs::read(dest.join("b (2).png")).unwrap(), b"b");

        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(
            undone,
            UndoReport {
                kind: Some(OpKind::Move),
                done: 2,
                failed: vec![]
            }
        );
        assert_eq!(fs::read(w.root().join("src/a.png")).unwrap(), b"a");
        assert_eq!(fs::read(w.root().join("src/b.png")).unwrap(), b"b");
        assert_eq!(fs::read(dest.join("b.png")).unwrap(), b"old");
        assert!(!dest.join("a.png").exists());
    }

    #[test]
    fn keep_both_with_a_stale_token_records_a_new_entry() {
        let w = World::new();
        let dest = w.mkdir("dest");
        fs::write(dest.join("b.png"), b"old").unwrap();
        let a = w.file("src/a.png", b"a");
        let b = w.file("src/b.png", b"b");
        let c = w.file("c.png", b"c");

        let first = w.mv(&[a, b], to_path(&dest), Conflict::Skip, None);
        let stale = first.token.unwrap();
        // 中间又做了别的操作，原 token 失效。
        let renamed = run_rename(&w.registry, &w.sessions, &w.undo, c, "d.png");
        assert!(renamed.token.is_some());

        let second = w.mv(&[b], to_path(&dest), Conflict::KeepBoth, Some(stale));
        let fresh = second.token.unwrap();
        assert_ne!(fresh, stale);

        // 只撤回第二批。
        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(
            undone,
            UndoReport {
                kind: Some(OpKind::Move),
                done: 1,
                failed: vec![]
            }
        );
        assert_eq!(fs::read(w.root().join("src/b.png")).unwrap(), b"b");
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"a");
    }

    #[test]
    fn new_child_creates_the_directory_under_the_session_root_and_undo_removes_it() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        let made = w.root().join("精选");

        let report = w.mv(
            &[a],
            Dest::NewChild {
                name: "精选".into(),
            },
            Conflict::Skip,
            None,
        );
        assert_eq!(report.done, vec![a]);
        let made_str = made.to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(made_str.as_str()));
        assert_eq!(fs::read(made.join("a.png")).unwrap(), b"a");
        assert_eq!(w.recents.list(), vec![made_str]);

        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(
            undone,
            UndoReport {
                kind: Some(OpKind::Move),
                done: 2,
                failed: vec![]
            }
        );
        assert_eq!(fs::read(w.root().join("a.png")).unwrap(), b"a");
        assert!(made.symlink_metadata().is_err());
    }

    #[test]
    fn new_child_with_no_successful_item_leaves_no_directory() {
        let w = World::new();
        let made = w.root().join("新目录");

        let report = w.mv(
            &[999],
            Dest::NewChild {
                name: "新目录".into(),
            },
            Conflict::Skip,
            None,
        );
        assert_eq!(report.failed, vec![fail(999, FsError::NotFound)]);
        assert_eq!(report.token, None);
        assert_eq!(report.dest, None);
        assert!(made.symlink_metadata().is_err());
        assert!(w.recents.list().is_empty());

        let a = w.file("a.png", b"a");
        let bad = w.mv(
            &[a],
            Dest::NewChild { name: "a/b".into() },
            Conflict::Skip,
            None,
        );
        assert_eq!(bad.failed, vec![fail(a, FsError::InvalidName)]);
        assert!(w.root().join("a.png").is_file());
    }

    #[test]
    fn new_child_reusing_an_existing_directory_keeps_it_after_undo() {
        let w = World::new();
        let existing = w.mkdir("sub");
        let a = w.file("a.png", b"a");
        // 不分大小写的卷上输入的写法与磁盘上的不同，结果仍应落在磁盘上的写法。
        let typed = if w.root().join("SUB").exists() {
            "Sub"
        } else {
            "sub"
        };

        let report = w.mv(
            &[a],
            Dest::NewChild { name: typed.into() },
            Conflict::Skip,
            None,
        );
        assert_eq!(report.done, vec![a]);
        let existing_str = existing.to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(existing_str.as_str()));
        assert_eq!(w.recents.list(), vec![existing_str]);
        assert_eq!(
            w.hints(),
            vec![vec![FsHint::Renamed {
                from: w.root().join("a.png"),
                to: existing.join("a.png")
            }]]
        );

        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(undone.done, 1);
        assert!(undone.failed.is_empty());
        assert_eq!(fs::read(w.root().join("a.png")).unwrap(), b"a");
        assert!(existing.is_dir());
    }

    #[test]
    fn new_child_reusing_an_existing_directory_with_no_success_keeps_it() {
        let w = World::new();
        let existing = w.mkdir("sub");

        let report = w.mv(
            &[999],
            Dest::NewChild { name: "sub".into() },
            Conflict::Skip,
            None,
        );
        assert_eq!(report.failed, vec![fail(999, FsError::NotFound)]);
        assert_eq!(report.token, None);
        assert!(existing.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn destination_path_is_canonicalised() {
        let w = World::new();
        let real = w.mkdir("real");
        let link = w.root().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let a = w.file("a.png", b"a");

        let report = w.mv(&[a], to_path(&link), Conflict::Skip, None);
        assert_eq!(report.done, vec![a]);
        let real_str = real.to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(real_str.as_str()));
        assert_eq!(w.recents.list(), vec![real_str]);
        assert_eq!(
            w.hints(),
            vec![vec![FsHint::Renamed {
                from: w.root().join("a.png"),
                to: real.join("a.png")
            }]]
        );

        // 解析不了（不存在）：每一项都是 NotFound。
        let b = w.file("b.png", b"b");
        let missing = w.mv(
            &[b],
            to_path(&w.root().join("missing")),
            Conflict::Skip,
            None,
        );
        assert_eq!(missing.failed, vec![fail(b, FsError::NotFound)]);
        assert_eq!(missing.dest, None);
    }

    #[test]
    fn new_child_without_a_session_fails_every_item() {
        let w = World::without_session();
        let a = w.file("a.png", b"a");
        let report = w.mv(
            &[a, 999],
            Dest::NewChild { name: "x".into() },
            Conflict::Skip,
            None,
        );
        assert_eq!(report.done, Vec::<u32>::new());
        assert_eq!(
            report.failed,
            vec![fail(a, FsError::NotFound), fail(999, FsError::NotFound)]
        );
        assert_eq!(report.dest, None);
        assert!(w.root().join("a.png").is_file());
        assert!(!w.root().join("x").exists());
    }

    #[test]
    fn dest_dir_deserializes() {
        let d: Dest =
            serde_json::from_value(serde_json::json!({ "kind": "dir", "dir": "a" })).unwrap();
        assert_eq!(d, Dest::Dir { dir: "a".into() });
    }

    fn rel(dir: &str) -> Dest {
        Dest::Dir { dir: dir.into() }
    }

    #[test]
    fn move_to_existing_subdir_by_relative_dir() {
        let w = World::new();
        let inner = w.mkdir("sub/inner");
        let a = w.file("a.png", b"a");

        let report = w.mv(&[a], rel("sub/inner"), Conflict::Skip, None);
        assert_eq!(report.done, vec![a]);
        assert!(report.token.is_some());
        let inner_str = inner.to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(inner_str.as_str()));
        assert_eq!(fs::read(inner.join("a.png")).unwrap(), b"a");
        assert!(!w.root().join("a.png").exists());
    }

    #[test]
    fn move_to_root_by_empty_dir() {
        let w = World::new();
        let a = w.file("sub/a.png", b"a");

        let report = w.mv(&[a], rel(""), Conflict::Skip, None);
        assert_eq!(report.done, vec![a]);
        let root_str = w.root().to_string_lossy().into_owned();
        assert_eq!(report.dest.as_deref(), Some(root_str.as_str()));
        assert_eq!(fs::read(w.root().join("a.png")).unwrap(), b"a");
        assert!(!w.root().join("sub/a.png").exists());
    }

    #[test]
    fn undo_after_move_to_relative_dir_restores() {
        let w = World::new();
        let a = w.file("sub/a.png", b"a");
        w.mv(&[a], rel(""), Conflict::Skip, None);

        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(undone.kind, Some(OpKind::Move));
        assert_eq!(undone.failed, vec![]);
        assert_eq!(fs::read(w.root().join("sub/a.png")).unwrap(), b"a");
        assert!(!w.root().join("a.png").exists());
    }

    #[test]
    fn relative_dir_rejects_escapes() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        for bad in ["../x", "/abs", "a//b", "a/./b", "a/.."] {
            let report = w.mv(&[a], rel(bad), Conflict::Skip, None);
            assert_eq!(report.done, Vec::<u32>::new(), "{bad}");
            assert_eq!(report.failed, vec![fail(a, FsError::InvalidName)], "{bad}");
            assert_eq!(report.dest, None, "{bad}");
        }
        assert!(w.root().join("a.png").is_file());
        let parent = w.root().parent().unwrap().join("x");
        assert!(!parent.exists());
        let names: Vec<_> = fs::read_dir(w.root()).unwrap().collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn relative_dir_must_exist_and_be_a_directory() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        for bad in ["nope", "a.png"] {
            let report = w.mv(&[a], rel(bad), Conflict::Skip, None);
            assert_eq!(report.failed, vec![fail(a, FsError::NotFound)], "{bad}");
        }
        assert!(w.root().join("a.png").is_file());
        assert!(!w.root().join("nope").exists());
        assert_eq!(fs::read_dir(w.root()).unwrap().count(), 1);
    }

    #[test]
    fn relative_dir_without_session_is_not_found() {
        let w = World::without_session();
        let a = w.file("a.png", b"a");
        let report = w.mv(&[a], rel(""), Conflict::Skip, None);
        assert_eq!(report.failed, vec![fail(a, FsError::NotFound)]);
        assert_eq!(report.dest, None);
    }

    #[test]
    fn recent_targets_are_deduplicated_and_capped_at_five() {
        let w = World::new();
        let dirs: Vec<PathBuf> = (0..7).map(|i| w.mkdir(&format!("d{i}"))).collect();
        let s = |i: usize| dirs[i].to_string_lossy().into_owned();
        for (i, dir) in dirs.iter().enumerate() {
            let id = w.file(&format!("f{i}.png"), b"x");
            run_transfer(
                &w.ctx(),
                OpKind::Move,
                &[id],
                &to_path(dir),
                Conflict::Skip,
                None,
            );
        }
        assert_eq!(w.recents.list(), vec![s(6), s(5), s(4), s(3), s(2)]);

        let id = w.file("again.png", b"x");
        w.mv(&[id], to_path(&dirs[4]), Conflict::Skip, None);
        assert_eq!(w.recents.list(), vec![s(4), s(6), s(5), s(3), s(2)]);
    }

    #[test]
    fn undo_with_nothing_to_undo_reports_no_kind() {
        let w = World::new();
        assert_eq!(
            run_undo(&w.sessions, &w.undo),
            UndoReport {
                kind: None,
                done: 0,
                failed: vec![]
            }
        );
        assert!(w.hints().is_empty());
    }

    #[test]
    fn undo_clears_the_log_even_when_a_step_fails() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        run_rename(&w.registry, &w.sessions, &w.undo, a, "b.png");
        w.hints();
        fs::remove_file(w.root().join("b.png")).unwrap();

        let undone = run_undo(&w.sessions, &w.undo);
        assert_eq!(
            undone,
            UndoReport {
                kind: Some(OpKind::Rename),
                done: 0,
                failed: vec![UndoFailure {
                    name: "b.png".into(),
                    code: FsError::NotFound
                }]
            }
        );
        assert!(w.hints().is_empty());
        assert_eq!(run_undo(&w.sessions, &w.undo).kind, None);
    }

    #[test]
    fn undo_sends_hints_to_the_session() {
        let w = World::new();
        let a = w.file("a.png", b"a");
        run_rename(&w.registry, &w.sessions, &w.undo, a, "b.png");
        w.hints();
        run_undo(&w.sessions, &w.undo);
        assert_eq!(
            w.hints(),
            vec![vec![FsHint::Renamed {
                from: w.root().join("b.png"),
                to: w.root().join("a.png")
            }]]
        );
    }

    #[test]
    fn reports_serialize_to_the_agreed_shape() {
        let report = OpReport {
            kind: OpKind::Move,
            done: vec![1],
            failed: vec![fail(2, FsError::Exists)],
            token: Some(7),
            dest: Some("/d".into()),
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "kind": "move", "done": [1], "failed": [{ "id": 2, "code": "exists" }],
                "token": 7, "dest": "/d"
            })
        );
        let empty = OpReport {
            kind: OpKind::Trash,
            done: vec![],
            failed: vec![],
            token: None,
            dest: None,
        };
        assert_eq!(
            serde_json::to_value(&empty).unwrap(),
            serde_json::json!({ "kind": "trash", "done": [], "failed": [], "token": null, "dest": null })
        );
        let undo = UndoReport {
            kind: Some(OpKind::Copy),
            done: 1,
            failed: vec![UndoFailure {
                name: "a.png".into(),
                code: FsError::RestoreDenied,
            }],
        };
        assert_eq!(
            serde_json::to_value(&undo).unwrap(),
            serde_json::json!({
                "kind": "copy", "done": 1,
                "failed": [{ "name": "a.png", "code": "restoreDenied" }]
            })
        );
        let none = UndoReport {
            kind: None,
            done: 0,
            failed: vec![],
        };
        assert_eq!(
            serde_json::to_value(&none).unwrap(),
            serde_json::json!({ "kind": null, "done": 0, "failed": [] })
        );
        let path: Dest =
            serde_json::from_value(serde_json::json!({ "kind": "path", "path": "/x" })).unwrap();
        assert_eq!(path, Dest::Path { path: "/x".into() });
        let child: Dest =
            serde_json::from_value(serde_json::json!({ "kind": "newChild", "name": "n" })).unwrap();
        assert_eq!(child, Dest::NewChild { name: "n".into() });
        let conflict: Conflict = serde_json::from_value(serde_json::json!("keepBoth")).unwrap();
        assert_eq!(conflict, Conflict::KeepBoth);
    }

    fn load_recents(dir: &Path) -> RecentTargets {
        RecentTargets::new(Arc::new(SessionStore::load(dir)))
    }

    #[test]
    fn remember_keeps_basket() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(SessionStore::load(dir.path()));
        store.set_basket(vec!["/x.png".into()]);
        RecentTargets::new(store).remember("/d".into());
        let again = SessionStore::load(dir.path());
        assert_eq!(again.basket(), vec!["/x.png".to_string()]);
        assert_eq!(again.recent_targets(), vec!["/d".to_string()]);
    }

    #[test]
    fn recent_targets_survive_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let r = load_recents(dir.path());
        r.remember("/a".into());
        r.remember("/b".into());
        let again = load_recents(dir.path());
        assert_eq!(again.list(), vec!["/b".to_string(), "/a".to_string()]);
    }

    #[test]
    fn recent_targets_load_truncates_to_five_and_drops_empty_strings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("session.json"),
            r#"{"recentTargets":["1","","2","3","4","5","6","7"]}"#,
        )
        .unwrap();
        let r = load_recents(dir.path());
        assert_eq!(r.list(), vec!["1", "2", "3", "4", "5"]);
    }

    #[test]
    fn recent_targets_tolerate_a_garbage_session_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("session.json"), "{not json").unwrap();
        let r = load_recents(dir.path());
        assert!(r.list().is_empty());
        r.remember("/x".into());
        let again = load_recents(dir.path());
        assert_eq!(again.list(), vec!["/x".to_string()]);
    }

    #[test]
    fn memory_recent_targets_keep_the_list() {
        let r = RecentTargets::new(Arc::new(SessionStore::memory()));
        r.remember("/x".into());
        assert_eq!(r.list(), vec!["/x".to_string()]);
    }
}
