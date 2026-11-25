use crate::catalog::registry::{FileId, Registry};
use crate::state::recents::is_cache_key;
use crate::thumbs::{ThumbCache, Tier};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::http;

/// 协议被调用的累计次数，供缓存实验读取。
pub static HITS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, PartialEq)]
pub enum Route {
    Image(FileId),
    Thumb(FileId, Tier),
    /// 按缓存键直接读缩略图（最近目录用）。
    ThumbKey(String),
}

/// 协议处理所需的共享状态。
pub struct Ctx<'a> {
    pub registry: &'a Registry,
    pub thumbs: &'a ThumbCache,
}

fn parse_u32(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 输入是请求 URI 的 path 部分，如 "/image/42"、"/thumb/42/320"、"/thumb-key/<32 位小写十六进制>"。
pub fn parse_route(path: &str) -> Option<Route> {
    if let Some(key) = path.strip_prefix("/thumb-key/") {
        return is_cache_key(key).then(|| Route::ThumbKey(key.to_string()));
    }
    if let Some(id) = path.strip_prefix("/image/") {
        return parse_u32(id).map(|n| Route::Image(FileId(n)));
    }
    let rest = path.strip_prefix("/thumb/")?;
    let (id, px) = rest.split_once('/')?;
    let tier = Tier::from_px(parse_u32(px)?)?;
    Some(Route::Thumb(FileId(parse_u32(id)?), tier))
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
        // 与 200 一致地放行跨源读取，否则 fetch() 只能看到网络错误，读不到 404。
        .header("access-control-allow-origin", "*")
        .body(Vec::new())
        .expect("static 404 response")
}

fn ok(mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("cache-control", "public, max-age=31536000, immutable")
        // WebView 的页面源与 glance:// 不同源，fetch() 读取需要 CORS 放行；<img> 不受影响。
        .header("access-control-allow-origin", "*")
        .body(body)
        .unwrap_or_else(|_| not_found())
}

fn serve_image(ctx: &Ctx, id: FileId) -> Option<http::Response<Vec<u8>>> {
    let file = ctx.registry.path(id)?;
    let mime = content_type(&file)?;
    let bytes = std::fs::read(&file).ok()?;
    Some(ok(mime, bytes))
}

/// 只读缓存，不触发生成；未缓存、未登记、原图已不存在都是 404。
fn serve_thumb(ctx: &Ctx, id: FileId, tier: Tier) -> Option<http::Response<Vec<u8>>> {
    let file = ctx.registry.path(id)?;
    let key = ThumbCache::key_for_file(&file, tier)?;
    Some(ok("image/webp", ctx.thumbs.get(&key)?))
}

/// 读文件并组装响应；任何失败都是 404，不 panic。
pub fn respond(ctx: &Ctx, path: &str) -> http::Response<Vec<u8>> {
    HITS.fetch_add(1, Ordering::Relaxed);
    let response = match parse_route(path) {
        Some(Route::Image(id)) => serve_image(ctx, id),
        Some(Route::Thumb(id, tier)) => serve_thumb(ctx, id, tier),
        Some(Route::ThumbKey(key)) => ctx.thumbs.get(&key).map(|b| ok("image/webp", b)),
        None => None,
    };
    response.unwrap_or_else(not_found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::{FileId, Registry};
    use crate::thumbs::worker::process;
    use glance_imaging::{RgbaView, encode_png_lossless};

    fn real_png(path: &std::path::Path) {
        let (w, h) = (400u32, 200u32);
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % 251) as u8, 80, 160, 255])
            .collect();
        let png = encode_png_lossless(RgbaView {
            width: w,
            height: h,
            data: &data,
        }, None)
        .unwrap();
        std::fs::write(path, png).unwrap();
    }

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
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let ctx = Ctx {
            registry: &r,
            thumbs: &cache,
        };
        let id = r.register(&file);
        let resp = respond(&ctx, &format!("/image/{}", id.0));
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
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let ctx = Ctx {
            registry: &r,
            thumbs: &cache,
        };
        let missing = respond(&ctx, "/image/7");
        assert_eq!(missing.status(), 404);
        // 404 也要放行跨源读取，否则 fetch() 只会报网络错误。
        assert_eq!(missing.headers()["access-control-allow-origin"], "*");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("gone.png");
        std::fs::write(&file, b"x").unwrap();
        let id = r.register(&file);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(respond(&ctx, &format!("/image/{}", id.0)).status(), 404);
    }

    #[test]
    fn parses_thumb_routes() {
        assert_eq!(
            parse_route("/thumb/42/320"),
            Some(Route::Thumb(FileId(42), Tier::S))
        );
        assert_eq!(
            parse_route("/thumb/42/640"),
            Some(Route::Thumb(FileId(42), Tier::L))
        );
        for bad in [
            "/thumb/42",
            "/thumb/42/",
            "/thumb/42/321",
            "/thumb/x/320",
            "/thumb/42/320/extra",
            "/thumb//320",
        ] {
            assert_eq!(parse_route(bad), None, "{bad}");
        }
    }

    #[test]
    fn parses_thumb_key_routes() {
        let key = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_route(&format!("/thumb-key/{key}")),
            Some(Route::ThumbKey(key.to_string()))
        );
    }

    #[test]
    fn rejects_malformed_thumb_keys() {
        for bad in [
            "/thumb-key/0123456789abcdef0123456789abcde",
            "/thumb-key/0123456789abcdef0123456789abcdef0",
            "/thumb-key/0123456789ABCDEF0123456789abcdef",
            "/thumb-key/0123456789abcdef/123456789abcdef",
            "/thumb-key/..%2f456789abcdef0123456789abcdef",
            "/thumb-key/",
            "/thumb-key",
        ] {
            assert_eq!(parse_route(bad), None, "{bad}");
        }
    }

    #[test]
    fn thumb_key_serves_cached_bytes_and_404s_when_absent() {
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let ctx = Ctx {
            registry: &r,
            thumbs: &cache,
        };
        let key = "0123456789abcdef0123456789abcdef";
        let url = format!("/thumb-key/{key}");
        let before = respond(&ctx, &url);
        assert_eq!(before.status(), 404);
        assert_eq!(before.headers()["access-control-allow-origin"], "*");

        cache.put(key, b"webp-bytes").unwrap();
        let resp = respond(&ctx, &url);
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/webp");
        assert_eq!(
            resp.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert_eq!(resp.body().as_slice(), b"webp-bytes");
    }

    #[test]
    fn serves_cached_thumb_and_404s_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.png");
        real_png(&file);
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let ctx = Ctx {
            registry: &r,
            thumbs: &cache,
        };
        let id = r.register(&file);
        let url = format!("/thumb/{}/320", id.0);

        let before = respond(&ctx, &url);
        assert_eq!(before.status(), 404);
        assert_eq!(before.headers()["access-control-allow-origin"], "*");

        process((id, Tier::S), &r, &cache);
        let key = ThumbCache::key_for_file(&file, Tier::S).unwrap();
        let resp = respond(&ctx, &url);
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/webp");
        assert_eq!(
            resp.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert_eq!(resp.body(), &cache.get(&key).unwrap());

        std::fs::remove_file(&file).unwrap();
        assert_eq!(respond(&ctx, &url).status(), 404);
        assert_eq!(respond(&ctx, "/thumb/9999/320").status(), 404);
    }
}
