//! 系统交来的“打开请求”：启动参数、二次启动、macOS 的打开事件。
//! 只处理字符串和路径，不碰磁盘；路径是否存在由 `open_path` 判断。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const OPEN_REQUEST: &str = "open_request";

/// 从命令行参数里挑出要打开的路径：跳过 `argv[0]`、空参数和开关；
/// Windows 上 `"D:\"` 会被解析成 `D:"`，末尾的引号还原成分隔符。
pub fn pick_target(argv: &[String], cwd: &Path) -> Option<PathBuf> {
    let arg = argv
        .iter()
        .skip(1)
        .find(|a| !a.is_empty() && !a.starts_with('-'))?;
    let mut text = arg.clone();
    if text.ends_with('"') {
        text.pop();
        text.push(std::path::MAIN_SEPARATOR);
    }
    Some(cwd.join(text))
}

/// macOS 的打开事件：第一个能换成路径的 `file:` 地址。
#[cfg(target_os = "macos")]
pub fn url_target(urls: &[tauri::Url]) -> Option<PathBuf> {
    urls.iter().find_map(|u| u.to_file_path().ok())
}

/// 最近一条尚未被前端取走的打开请求。
#[derive(Default)]
pub struct OpenRequests(Mutex<Option<String>>);

impl OpenRequests {
    pub fn put(&self, path: &Path) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(path.to_string_lossy().into_owned());
    }

    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// 把主窗口带到前面；失败一律忽略。
pub fn bring_to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 记下请求、唤起窗口、通知前端。
pub fn submit(app: &AppHandle, path: PathBuf) {
    app.state::<OpenRequests>().put(&path);
    bring_to_front(app);
    let _ = app.emit(OPEN_REQUEST, ());
}

#[tauri::command]
pub fn take_open_request(reqs: State<'_, OpenRequests>) -> Option<String> {
    reqs.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 没有参数就没有目标() {
        assert_eq!(pick_target(&args(&["glance"]), Path::new("/w")), None);
        assert_eq!(pick_target(&[], Path::new("/w")), None);
    }
    #[test]
    fn 跳过开关和空参数() {
        assert_eq!(
            pick_target(&args(&["glance", "-psn_0_1", "", "--x"]), Path::new("/w")),
            None
        );
        assert_eq!(
            pick_target(&args(&["glance", "--x", "/a/b.png", "/c"]), Path::new("/w")),
            Some(PathBuf::from("/a/b.png"))
        );
    }
    #[test]
    fn 相对路径接到工作目录上() {
        assert_eq!(
            pick_target(&args(&["glance", "pics"]), Path::new("/w")),
            Some(PathBuf::from("/w/pics"))
        );
    }
    #[test]
    fn 末尾的引号还原成分隔符() {
        let got = pick_target(&args(&["glance", "D:\""]), Path::new("/w")).unwrap();
        assert!(got
            .to_string_lossy()
            .ends_with(&format!("D:{}", std::path::MAIN_SEPARATOR)));
    }
    #[test]
    fn 请求只留最新一条且只能取一次() {
        let r = OpenRequests::default();
        assert_eq!(r.take(), None);
        r.put(Path::new("/a"));
        r.put(Path::new("/b"));
        assert_eq!(r.take().as_deref(), Some("/b"));
        assert_eq!(r.take(), None);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn 只认文件地址() {
        let u = |s: &str| tauri::Url::parse(s).unwrap();
        assert_eq!(
            url_target(&[u("https://x.test/a"), u("file:///a/b%20c.png")]),
            Some(PathBuf::from("/a/b c.png"))
        );
        assert_eq!(url_target(&[u("glance://x")]), None);
        assert_eq!(url_target(&[]), None);
    }
}
