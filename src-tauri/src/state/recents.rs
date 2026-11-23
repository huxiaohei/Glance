//! 最近打开的目录：`<配置目录>/recents.json`。
use super::settings::SortKey;
use super::store;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 未固定项最多保留的个数；固定项不计入。
pub const RECENT_DIRS: usize = 8;
/// 每项最多记的缩略图缓存键个数（320 档）。
pub const RECENT_THUMBS: usize = 4;

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recent {
    pub path: String,
    pub name: String,
    pub count: Option<u32>,
    /// 缩略图缓存键，最多 4 个。
    pub thumbs: Vec<String>,
    pub pinned: bool,
    /// 上次看到的图片，相对根目录，用 '/' 分隔。不发给前端。
    pub last: Option<String>,
    pub sort: Option<SortKey>,
    pub include_subdirs: Option<bool>,
}

/// 打开一个目录后汇报的状态。
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub count: u32,
    pub thumbs: Vec<String>,
    pub last: Option<String>,
    pub sort: SortKey,
    pub include_subdirs: bool,
}

/// 缓存键：恰好 32 个小写十六进制字符。
pub fn is_cache_key(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 纯逻辑，内部按“最近使用在前”保存。
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecentList(Vec<Recent>);

impl RecentList {
    /// 已有则移到最前并更新 name（其余字段保留），没有则新建；之后裁剪。
    pub fn touch(&mut self, path: &str, name: &str) {
        let mut item = match self.0.iter().position(|r| r.path == path) {
            Some(i) => self.0.remove(i),
            None => Recent {
                path: path.to_string(),
                ..Recent::default()
            },
        };
        item.name = name.to_string();
        self.0.insert(0, item);
        self.trim();
    }

    /// 设置固定状态，之后裁剪（取消固定可能挤掉最旧的未固定项）。
    pub fn pin(&mut self, path: &str, pinned: bool) {
        if let Some(r) = self.0.iter_mut().find(|r| r.path == path) {
            r.pinned = pinned;
        }
        self.trim();
    }

    pub fn remove(&mut self, path: &str) {
        self.0.retain(|r| r.path != path);
    }

    /// 没有该项则不做事。
    pub fn note(&mut self, path: &str, note: Note) {
        if let Some(r) = self.0.iter_mut().find(|r| r.path == path) {
            r.count = Some(note.count);
            r.thumbs = note.thumbs;
            r.last = note.last;
            r.sort = Some(note.sort);
            r.include_subdirs = Some(note.include_subdirs);
        }
    }

    pub fn get(&self, path: &str) -> Option<&Recent> {
        self.0.iter().find(|r| r.path == path)
    }

    /// 固定项在前，各自保持最近使用的顺序。
    pub fn ordered(&self) -> Vec<&Recent> {
        let pinned = self.0.iter().filter(|r| r.pinned);
        pinned.chain(self.0.iter().filter(|r| !r.pinned)).collect()
    }

    /// 固定项全部保留；未固定项只留最近的 RECENT_DIRS 个。
    fn trim(&mut self) {
        let mut unpinned = 0;
        self.0.retain(|r| {
            if r.pinned {
                return true;
            }
            unpinned += 1;
            unpinned <= RECENT_DIRS
        });
    }

    /// 读盘后的清理：丢掉空路径与重复路径，缩略图键只留合法的前 4 个，再裁剪。
    fn sanitise(&mut self) {
        let mut seen = HashSet::new();
        self.0
            .retain(|r| !r.path.is_empty() && seen.insert(r.path.clone()));
        for r in &mut self.0 {
            r.thumbs.retain(|k| is_cache_key(k));
            r.thumbs.truncate(RECENT_THUMBS);
        }
        self.trim();
    }
}

/// 发给前端的形状：没有 last，多一个 exists。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub count: Option<u32>,
    pub thumbs: Vec<String>,
    pub pinned: bool,
    pub exists: bool,
    pub sort: Option<SortKey>,
    pub include_subdirs: Option<bool>,
}

pub struct RecentsState {
    path: PathBuf,
    list: Mutex<RecentList>,
}

impl RecentsState {
    /// 读 `<config_dir>/recents.json`；读不出或不是数组时为空表。
    /// 逐项宽松解析：某一项读不出（例如将来版本写入的新排序值）只丢这一项，
    /// 不连累整个文件，否则下一次写盘会把其余各项（含固定项）一并清掉。
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("recents.json");
        let items: Vec<serde_json::Value> = store::load(&path);
        let mut list = RecentList(
            items
                .into_iter()
                .filter_map(|v| serde_json::from_value::<Recent>(v).ok())
                .collect(),
        );
        list.sanitise();
        Self {
            path,
            list: Mutex::new(list),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RecentList> {
        self.list.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 改完持锁写盘，并发调用串行化；写盘失败只忽略（不影响打开）。
    pub fn update<R>(&self, f: impl FnOnce(&mut RecentList) -> R) -> R {
        let mut list = self.lock();
        let out = f(&mut list);
        let _ = store::save(&self.path, &*list);
        out
    }

    /// 按显示顺序；exists = 路径当前是目录。会 stat 每一项，不上主线程。
    pub fn entries(&self) -> Vec<RecentEntry> {
        let items: Vec<Recent> = self.lock().ordered().into_iter().cloned().collect();
        items
            .into_iter()
            .map(|r| RecentEntry {
                exists: Path::new(&r.path).is_dir(),
                path: r.path,
                name: r.name,
                count: r.count,
                thumbs: r.thumbs,
                pinned: r.pinned,
                sort: r.sort,
                include_subdirs: r.include_subdirs,
            })
            .collect()
    }

    pub fn last_of(&self, path: &str) -> Option<String> {
        self.lock().get(path)?.last.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const K: &str = "0123456789abcdef0123456789abcdef";

    fn paths(list: &RecentList) -> Vec<&str> {
        list.ordered().iter().map(|r| r.path.as_str()).collect()
    }

    fn note(count: u32) -> Note {
        Note {
            count,
            thumbs: vec![K.to_string()],
            last: Some("a/b.png".into()),
            sort: SortKey::Mtime,
            include_subdirs: false,
        }
    }

    #[test]
    fn touch_adds_new_dirs_in_front_and_moves_existing_ones() {
        let mut l = RecentList::default();
        l.touch("/a", "a");
        l.touch("/b", "b");
        assert_eq!(paths(&l), ["/b", "/a"]);
        l.touch("/a", "a2");
        assert_eq!(paths(&l), ["/a", "/b"]);
        assert_eq!(l.get("/a").unwrap().name, "a2");
    }

    #[test]
    fn touch_keeps_the_other_fields_of_an_existing_entry() {
        let mut l = RecentList::default();
        l.touch("/a", "a");
        l.note("/a", note(5));
        l.pin("/a", true);
        l.touch("/b", "b");
        l.touch("/a", "renamed");
        let a = l.get("/a").unwrap();
        assert_eq!(a.name, "renamed");
        assert_eq!(a.count, Some(5));
        assert_eq!(a.thumbs, vec![K.to_string()]);
        assert!(a.pinned);
        assert_eq!(a.last.as_deref(), Some("a/b.png"));
    }

    #[test]
    fn keeps_only_eight_unpinned_entries() {
        let mut l = RecentList::default();
        for i in 0..10 {
            l.touch(&format!("/d{i}"), "d");
        }
        let expected: Vec<String> = (2..10).rev().map(|i| format!("/d{i}")).collect();
        assert_eq!(paths(&l), expected);
    }

    #[test]
    fn pinned_entries_do_not_count_and_are_never_dropped() {
        let mut l = RecentList::default();
        l.touch("/p1", "p1");
        l.touch("/p2", "p2");
        l.pin("/p1", true);
        l.pin("/p2", true);
        for i in 0..10 {
            l.touch(&format!("/d{i}"), "d");
        }
        let got = paths(&l);
        assert_eq!(got.len(), 2 + RECENT_DIRS);
        assert_eq!(&got[..2], ["/p2", "/p1"]);
        assert_eq!(got[2], "/d9");
        assert_eq!(got[9], "/d2");
    }

    #[test]
    fn unpinning_can_push_out_the_oldest() {
        let mut l = RecentList::default();
        l.touch("/p1", "p1");
        l.touch("/p2", "p2");
        l.pin("/p1", true);
        l.pin("/p2", true);
        for i in 0..8 {
            l.touch(&format!("/d{i}"), "d");
        }
        assert_eq!(paths(&l).len(), 10);
        // p2 比所有 d* 都旧，取消固定后它就是最旧的未固定项
        l.pin("/p2", false);
        let got = paths(&l);
        assert_eq!(got.len(), 9);
        assert!(!got.contains(&"/p2"));
        assert!(got.contains(&"/d0"));
        // p1 比 d0 新时，挤掉的是 d0
        let mut l = RecentList::default();
        l.touch("/p1", "p1");
        l.pin("/p1", true);
        for i in 0..8 {
            l.touch(&format!("/d{i}"), "d");
        }
        l.touch("/p1", "p1");
        l.pin("/p1", false);
        let got = paths(&l);
        assert_eq!(got.len(), 8);
        assert_eq!(got[0], "/p1");
        assert!(!got.contains(&"/d0"));
    }

    #[test]
    fn ordered_puts_pinned_first_each_in_recency_order() {
        let mut l = RecentList::default();
        for p in ["/a", "/b", "/c", "/d"] {
            l.touch(p, "x");
        }
        l.pin("/a", true);
        l.pin("/c", true);
        assert_eq!(paths(&l), ["/c", "/a", "/d", "/b"]);
    }

    #[test]
    fn remove_drops_the_entry_and_note_on_a_missing_path_does_nothing() {
        let mut l = RecentList::default();
        l.touch("/a", "a");
        l.touch("/b", "b");
        l.remove("/a");
        assert_eq!(paths(&l), ["/b"]);
        let before = l.clone();
        l.note("/nope", note(3));
        assert_eq!(l, before);
        l.remove("/nope");
        assert_eq!(l, before);
    }

    #[test]
    fn note_overwrites_count_thumbs_last_sort_and_subdirs() {
        let mut l = RecentList::default();
        l.touch("/a", "a");
        l.note("/a", note(5));
        l.note(
            "/a",
            Note {
                count: 9,
                thumbs: vec![],
                last: None,
                sort: SortKey::Size,
                include_subdirs: true,
            },
        );
        let a = l.get("/a").unwrap();
        assert_eq!(a.count, Some(9));
        assert!(a.thumbs.is_empty());
        assert_eq!(a.last, None);
        assert_eq!(a.sort, Some(SortKey::Size));
        assert_eq!(a.include_subdirs, Some(true));
        assert_eq!(a.name, "a");
    }

    #[test]
    fn entries_mark_missing_dirs_and_files_as_not_existing() {
        let cfg = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let keep = tmp.path().join("keep");
        let gone = tmp.path().join("gone");
        let file = tmp.path().join("file");
        for d in [&keep, &gone, &file] {
            std::fs::create_dir(d).unwrap();
        }
        let st = RecentsState::load(cfg.path());
        for d in [&keep, &gone, &file] {
            st.update(|l| l.touch(&d.to_string_lossy(), "x"));
        }
        std::fs::remove_dir(&gone).unwrap();
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, "x").unwrap();
        let got: Vec<(String, bool)> = st
            .entries()
            .into_iter()
            .map(|e| (e.path, e.exists))
            .collect();
        assert_eq!(
            got,
            vec![
                (file.to_string_lossy().into_owned(), false),
                (gone.to_string_lossy().into_owned(), false),
                (keep.to_string_lossy().into_owned(), true),
            ]
        );
    }

    #[test]
    fn wire_entry_has_no_last_field() {
        let e = RecentEntry {
            path: "/a".into(),
            name: "a".into(),
            count: Some(2),
            thumbs: vec![K.into()],
            pinned: true,
            exists: true,
            sort: Some(SortKey::Mtime),
            include_subdirs: Some(false),
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            json!({"path":"/a","name":"a","count":2,"thumbs":[K],"pinned":true,
                   "exists":true,"sort":"mtime","includeSubdirs":false})
        );
    }

    #[test]
    fn load_sanitises_what_it_reads() {
        let cfg = tempfile::tempdir().unwrap();
        let mut items: Vec<serde_json::Value> = (0..12)
            .map(|i| json!({"path": format!("/d{i}"), "name": "d"}))
            .collect();
        items[0]["thumbs"] = json!([K, "../x", K, "ABCDEF0123456789ABCDEF0123456789", K, K, K, K]);
        items.insert(1, json!({"path": "", "name": "empty"}));
        std::fs::write(
            cfg.path().join("recents.json"),
            serde_json::to_vec(&items).unwrap(),
        )
        .unwrap();
        let st = RecentsState::load(cfg.path());
        let entries = st.entries();
        assert_eq!(entries.len(), RECENT_DIRS);
        assert_eq!(entries[0].path, "/d0");
        assert!(entries.iter().all(|e| !e.path.is_empty()));
        for e in &entries {
            assert!(e.thumbs.len() <= RECENT_THUMBS);
            assert!(e.thumbs.iter().all(|k| is_cache_key(k)), "{:?}", e.thumbs);
        }
        assert_eq!(entries[0].thumbs, vec![K; 4]);
    }

    #[test]
    fn garbage_file_loads_empty_and_next_update_writes_a_valid_file() {
        let cfg = tempfile::tempdir().unwrap();
        let file = cfg.path().join("recents.json");
        std::fs::write(&file, "{not json").unwrap();
        let st = RecentsState::load(cfg.path());
        assert!(st.entries().is_empty());
        st.update(|l| l.touch("/a", "a"));
        let back: Vec<Recent> = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].path, "/a");
    }

    #[test]
    fn update_persists() {
        let cfg = tempfile::tempdir().unwrap();
        let st = RecentsState::load(cfg.path());
        st.update(|l| {
            l.touch("/a", "a");
            l.note("/a", note(4));
            l.touch("/b", "b");
            l.pin("/a", true);
        });
        let again = RecentsState::load(cfg.path());
        assert_eq!(again.last_of("/a").as_deref(), Some("a/b.png"));
        assert_eq!(again.last_of("/b"), None);
        let got: Vec<(String, bool, Option<u32>)> = again
            .entries()
            .into_iter()
            .map(|e| (e.path, e.pinned, e.count))
            .collect();
        assert_eq!(
            got,
            vec![("/a".into(), true, Some(4)), ("/b".into(), false, None)]
        );
    }

    #[test]
    fn load_drops_only_the_entries_that_do_not_parse() {
        let cfg = tempfile::tempdir().unwrap();
        let items = json!([
            {"path": "/a", "name": "a", "pinned": true, "sort": "mtime"},
            {"path": "/b", "name": "b", "sort": "future"},
            {"path": "/c", "name": "c", "includeSubdirs": false},
        ]);
        std::fs::write(
            cfg.path().join("recents.json"),
            serde_json::to_vec(&items).unwrap(),
        )
        .unwrap();
        let st = RecentsState::load(cfg.path());
        let got: Vec<(String, bool)> = st
            .entries()
            .into_iter()
            .map(|e| (e.path, e.pinned))
            .collect();
        assert_eq!(got, vec![("/a".into(), true), ("/c".into(), false)]);
        // 下一次写盘也保留它们（固定项不被清掉）
        st.update(|l| l.touch("/d", "d"));
        let again = RecentsState::load(cfg.path());
        let paths: Vec<String> = again.entries().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["/a", "/d", "/c"]);
    }

    #[test]
    fn file_that_is_not_an_array_loads_empty() {
        let cfg = tempfile::tempdir().unwrap();
        std::fs::write(
            cfg.path().join("recents.json"),
            br#"{"path":"/a","name":"a"}"#,
        )
        .unwrap();
        assert!(RecentsState::load(cfg.path()).entries().is_empty());
    }
}
