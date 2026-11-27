use crate::catalog::registry::{FileId, Registry};
use crate::decode::{DecodeError, Decoder};
use crate::edit::EditState;
use crate::state::recents::is_cache_key;
use crate::thumbs::{ThumbCache, Tier};
use glance_imaging::heif;
use glance_imaging::{SrcFormat, src_format_of};
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
    /// 编辑预览：会话号与版本号。
    Edit(u32, u32),
    /// 编辑会话的代理图（已转正）。
    EditSource(u32),
}

/// 协议处理所需的共享状态。
pub struct Ctx<'a> {
    pub registry: &'a Registry,
    pub thumbs: &'a ThumbCache,
    pub edit: &'a EditState,
    /// 显示通道的解码依赖；生产路径是 [`Decoder::SYSTEM`]，测试换成替身。
    pub decoder: Decoder,
}

impl<'a> Ctx<'a> {
    pub fn new(registry: &'a Registry, thumbs: &'a ThumbCache, edit: &'a EditState) -> Self {
        Ctx {
            registry,
            thumbs,
            edit,
            decoder: Decoder::SYSTEM,
        }
    }
}

fn parse_u32(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 输入是请求 URI 的 path 部分，如 "/image/42"、"/thumb/42/320"、"/thumb-key/<32 位小写十六进制>"、
/// "/edit/3/7"。
pub fn parse_route(path: &str) -> Option<Route> {
    if let Some(rest) = path.strip_prefix("/edit/") {
        let (session, rev) = rest.split_once('/')?;
        if rev == "source" {
            return Some(Route::EditSource(parse_u32(session)?));
        }
        return Some(Route::Edit(parse_u32(session)?, parse_u32(rev)?));
    }
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

/// 扩展名是 HEIC / HEIF / AVIF 之一：内容才决定怎么返回。
fn is_heif_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["heic", "heif", "avif"].contains(&e.to_ascii_lowercase().as_str()))
}

fn mime_of(f: SrcFormat) -> &'static str {
    match f {
        SrcFormat::Png => "image/png",
        SrcFormat::Jpeg => "image/jpeg",
        SrcFormat::Webp => "image/webp",
        SrcFormat::Gif => "image/gif",
        SrcFormat::Bmp => "image/bmp",
    }
}

/// 空应答体，只有状态码。
fn bare(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        // 与 200 一致地放行跨源读取，否则 fetch() 只能看到网络错误，读不到状态码。
        .header("access-control-allow-origin", "*")
        .body(Vec::new())
        .expect("static bare response")
}

fn not_found() -> http::Response<Vec<u8>> {
    bare(404)
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

/// 编辑预览：会话号在重启后会重复，不得让 WebView 缓存。
fn serve_edit(ctx: &Ctx, session: u32, rev: u32) -> Option<http::Response<Vec<u8>>> {
    let (enc, mime) = ctx.edit.bytes(session, rev)?;
    // 会话里的结果是共享的；协议应答体要一份自有的 Vec，只在这里复制一次。
    let body = enc.bytes.clone();
    http::Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .header("access-control-allow-origin", "*")
        .body(body)
        .ok()
}

/// 编辑会话的代理图，同样不得缓存。
fn serve_edit_source(ctx: &Ctx, session: u32) -> Option<http::Response<Vec<u8>>> {
    let (bytes, mime) = ctx.edit.source_image(session)?;
    http::Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .header("access-control-allow-origin", "*")
        .body(bytes.to_vec())
        .ok()
}

/// 原图。内容是 HEIF / AVIF（不论扩展名）→ 后端解码成不压缩的 PNG：本机没有解码器是 415，
/// 解不出来是 404。其余原样返回：MIME 按扩展名，扩展名是 HEIC / HEIF / AVIF 而内容不是时按内容。
fn serve_image(ctx: &Ctx, id: FileId) -> Option<http::Response<Vec<u8>>> {
    let file = ctx.registry.path(id)?;
    let by_ext = content_type(&file);
    if by_ext.is_none() && !is_heif_ext(&file) {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    if heif::sniff(&bytes).is_some() {
        return Some(match ctx.decoder.display_png(&bytes) {
            Ok(png) => ok("image/png", png),
            Err(DecodeError::NoCodec) => bare(415),
            Err(_) => not_found(),
        });
    }
    let mime = match by_ext {
        Some(m) => m,
        None => mime_of(src_format_of(&bytes)?),
    };
    Some(ok(mime, bytes))
}

/// 只读缓存，不触发生成；未缓存、未登记、原图已不存在都是 404。
fn serve_thumb(ctx: &Ctx, id: FileId, tier: Tier) -> Option<http::Response<Vec<u8>>> {
    let file = ctx.registry.path(id)?;
    let key = ThumbCache::key_for_file(&file, tier)?;
    Some(ok("image/webp", ctx.thumbs.get(&key)?))
}

/// 读文件并组装响应；不 panic。失败都是 404，只有本机缺 HEIF / AVIF 解码器时是 415。
pub fn respond(ctx: &Ctx, path: &str) -> http::Response<Vec<u8>> {
    HITS.fetch_add(1, Ordering::Relaxed);
    let response = match parse_route(path) {
        Some(Route::Image(id)) => serve_image(ctx, id),
        Some(Route::Thumb(id, tier)) => serve_thumb(ctx, id, tier),
        Some(Route::ThumbKey(key)) => ctx.thumbs.get(&key).map(|b| ok("image/webp", b)),
        Some(Route::Edit(session, rev)) => serve_edit(ctx, session, rev),
        Some(Route::EditSource(session)) => serve_edit_source(ctx, session),
        None => None,
    };
    response.unwrap_or_else(not_found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::registry::{FileId, Registry};
    use crate::thumbs::worker::process;
    use glance_imaging::{EditParams, OutFormat, RgbaView, encode_png_lossless};

    fn real_png(path: &std::path::Path) {
        let (w, h) = (400u32, 200u32);
        let data: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % 251) as u8, 80, 160, 255])
            .collect();
        let png = encode_png_lossless(
            RgbaView {
                width: w,
                height: h,
                data: &data,
            },
            None,
        )
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
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
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

    fn heic_head() -> Vec<u8> {
        let mut b = glance_imaging::heif::testkit::ftyp(b"heic", &[*b"mif1", *b"heic"]);
        b.extend_from_slice(&[0; 64]);
        b
    }

    #[test]
    fn serve_image_sniffs_content() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        // 系统解码器一调就报 NoCodec：PNG 字节若误走系统解码，这里就会是 415。
        let ctx = Ctx {
            decoder: crate::decode::no_codec_decoder(),
            ..Ctx::new(&r, &cache, &edit)
        };
        // 扩展名是 .heic，内容是 PNG：按内容给 MIME，原样返回。
        let file = dir.path().join("x.heic");
        real_png(&file);
        let id = r.register(&file);
        let resp = respond(&ctx, &format!("/image/{}", id.0));
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/png");
        assert_eq!(
            resp.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(resp.body(), &std::fs::read(&file).unwrap());
        // 内容认不出的新扩展名文件：404。
        let junk = dir.path().join("y.avif");
        std::fs::write(&junk, b"junk").unwrap();
        let id = r.register(&junk);
        assert_eq!(respond(&ctx, &format!("/image/{}", id.0)).status(), 404);
    }

    #[test]
    fn no_codec_is_415() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        let dec = crate::decode::no_codec_decoder();
        let ctx = Ctx {
            decoder: dec,
            ..Ctx::new(&r, &cache, &edit)
        };
        // 扩展名是 .png，内容是 HEIC：按内容走系统解码。
        let file = dir.path().join("x.png");
        std::fs::write(&file, heic_head()).unwrap();
        let id = r.register(&file);
        let resp = respond(&ctx, &format!("/image/{}", id.0));
        assert_eq!(resp.status(), 415);
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert!(resp.body().is_empty());
        assert_eq!(dec.codecs.missing(glance_syscodec::Kind::Heif), Some(true));
    }

    #[test]
    fn heif_decode_failure_is_404() {
        fn bad(
            _: &[u8],
            _: glance_syscodec::Kind,
            _: u64,
            _: Option<u32>,
        ) -> Result<glance_syscodec::Image, glance_syscodec::CodecError> {
            Err(glance_syscodec::CodecError::Decode("坏".into()))
        }
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        let ctx = Ctx {
            decoder: crate::decode::Decoder {
                sys: bad,
                ..crate::decode::no_codec_decoder()
            },
            ..Ctx::new(&r, &cache, &edit)
        };
        let file = dir.path().join("x.heic");
        std::fs::write(&file, heic_head()).unwrap();
        let id = r.register(&file);
        let resp = respond(&ctx, &format!("/image/{}", id.0));
        assert_eq!(resp.status(), 404);
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    }

    #[test]
    fn unknown_id_and_deleted_file_are_404() {
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
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
    fn parses_edit_routes() {
        assert_eq!(parse_route("/edit/3/7"), Some(Route::Edit(3, 7)));
        for bad in [
            "/edit/3",
            "/edit/a/1",
            "/edit/3/7/x",
            "/edit/3/",
            "/edit//7",
            "/edit/-1/2",
            "/edit/3/sourcex",
            "/edit//source",
            "/edit/3/source/x",
            "/edit/3/Source",
        ] {
            assert_eq!(parse_route(bad), None, "{bad}");
        }
        assert_eq!(parse_route("/edit/3/source"), Some(Route::EditSource(3)));
    }

    #[test]
    fn edit_source_route_serves_proxy_while_session_lives() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.png");
        real_png(&file);
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
        let s = edit.open(&r, r.register(&file)).unwrap().session;
        let resp = respond(&ctx, &format!("/edit/{s}/source"));
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/jpeg");
        assert_eq!(resp.headers()["cache-control"], "no-store");
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert_eq!(resp.body(), &edit.source_image(s).unwrap().0.to_vec());
        assert_eq!(
            respond(&ctx, &format!("/edit/{}/source", s + 1)).status(),
            404
        );
        edit.close(s);
        assert_eq!(respond(&ctx, &format!("/edit/{s}/source")).status(), 404);
    }

    #[test]
    fn edit_route_serves_latest_result_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.png");
        real_png(&file);
        let r = Registry::default();
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = ThumbCache::new(cache_dir.path().to_path_buf());
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
        let s = edit.open(&r, r.register(&file)).unwrap().session;
        assert_eq!(respond(&ctx, &format!("/edit/{s}/1")).status(), 404);
        let webp = EditParams::Convert {
            format: OutFormat::Webp,
            quality: 80,
            fill: [255; 3],
        };
        edit.preview(s, 1, webp, false).unwrap().unwrap();
        let resp = respond(&ctx, &format!("/edit/{s}/1"));
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["content-type"], "image/webp");
        // 会话号重启后会重复，不能让 WebView 长期缓存。
        assert_eq!(resp.headers()["cache-control"], "no-store");
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert_eq!(resp.body(), &edit.bytes(s, 1).unwrap().0.bytes);
        let jpeg = EditParams::Convert {
            format: OutFormat::Jpeg,
            quality: 80,
            fill: [255; 3],
        };
        edit.preview(s, 2, jpeg, false).unwrap().unwrap();
        assert_eq!(respond(&ctx, &format!("/edit/{s}/1")).status(), 404);
        let resp = respond(&ctx, &format!("/edit/{s}/2"));
        assert_eq!(resp.headers()["content-type"], "image/jpeg");
        assert_eq!(respond(&ctx, &format!("/edit/{}/2", s + 1)).status(), 404);
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
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
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
        let edit = EditState::default();
        let ctx = Ctx::new(&r, &cache, &edit);
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
