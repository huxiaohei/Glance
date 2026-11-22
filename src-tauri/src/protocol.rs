use crate::catalog::registry::{FileId, Registry};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::http;

/// 协议被调用的累计次数，供缓存实验读取。
pub static HITS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, PartialEq)]
pub enum Route {
    Image(FileId),
}

/// 输入是请求 URI 的 path 部分，如 "/image/42"。
pub fn parse_route(path: &str) -> Option<Route> {
    let id = path.strip_prefix("/image/")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    id.parse::<u32>().ok().map(|n| Route::Image(FileId(n)))
}

fn content_type(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn not_found() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(404)
        .body(Vec::new())
        .expect("static 404 response")
}

/// 读文件并组装响应；任何失败都是 404，不 panic。
pub fn respond(registry: &Registry, path: &str) -> http::Response<Vec<u8>> {
    HITS.fetch_add(1, Ordering::Relaxed);
    let Some(Route::Image(id)) = parse_route(path) else {
        return not_found();
    };
    let Some(file) = registry.path(id) else {
        return not_found();
    };
    let Some(mime) = content_type(&file) else {
        return not_found();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return not_found();
    };
    http::Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("cache-control", "public, max-age=31536000, immutable")
        // WebView 的页面源与 glance:// 不同源，fetch() 读取需要 CORS 放行；<img> 不受影响。
        .header("access-control-allow-origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::{FileId, Registry};

    #[test]
    fn parses_only_well_formed_routes() {
        assert_eq!(parse_route("/image/42"), Some(Route::Image(FileId(42))));
        for bad in [
            "/image/",
            "/image/abc",
            "/image/42/extra",
            "/image/-1",
            "/image/4294967296",
            "/other/1",
            "",
            "/image/../1",
        ] {
            assert_eq!(parse_route(bad), None, "{bad}");
        }
    }

    #[test]
    fn serves_registered_file_with_awkward_path() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("武将 立绘").join("蜀国#1");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("赵云 100%.png");
        std::fs::write(&file, b"\x89PNG-bytes").unwrap();
        let r = Registry::default();
        let id = r.register(&file);
        let resp = respond(&r, &format!("/image/{}", id.0));
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/png");
        assert_eq!(
            resp.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(resp.body().as_slice(), b"\x89PNG-bytes");
    }

    #[test]
    fn unknown_id_and_deleted_file_are_404() {
        let r = Registry::default();
        assert_eq!(respond(&r, "/image/7").status(), 404);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("gone.png");
        std::fs::write(&file, b"x").unwrap();
        let id = r.register(&file);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(respond(&r, &format!("/image/{}", id.0)).status(), 404);
    }
}
