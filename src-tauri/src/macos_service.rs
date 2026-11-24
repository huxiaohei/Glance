//! macOS 系统服务“用 Glance 打开”：访达里选中目录或图片后经服务菜单交来。
//! 回调在主线程，只从剪贴板对象里取路径交给 `shell::submit`，不碰磁盘。

use std::path::PathBuf;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardURLReadingFileURLsOnlyKey};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
use tauri::AppHandle;

use crate::shell;

static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    // SAFETY:
    // - 父类 NSObject 没有子类化要求。
    // - `ServiceProvider` 没有实现 `Drop`。
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "GlanceServiceProvider"]
    struct ServiceProvider;

    impl ServiceProvider {
        // SAFETY: 签名与 `-openInGlance:userData:error:` 一致。
        #[unsafe(method(openInGlance:userData:error:))]
        fn open_in_glance(
            &self,
            pboard: &NSPasteboard,
            _user_data: Option<&NSString>,
            _error: *mut *mut NSString,
        ) {
            if let (Some(app), Some(path)) = (APP.get(), first_path(pboard)) {
                shell::submit(app, path);
            }
        }
    }
);

impl ServiceProvider {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject 的 `init` 签名正确。
        unsafe { msg_send![super(this), init] }
    }
}

/// 登记服务对象；只在主线程调用（`setup` 里）。
pub fn install(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let _ = APP.set(app.clone());
    let provider = ServiceProvider::new(mtm);
    let ns_app = NSApplication::sharedApplication(mtm);
    // SAFETY: 服务对象实现了 Info.plist 里声明的选择子。
    unsafe { ns_app.setServicesProvider(Some(&provider)) };
    // 应用不保证持有它：留到进程结束。
    std::mem::forget(provider);
}

/// 剪贴板对象里第一个文件地址的路径；只认文件地址。
fn first_path(pboard: &NSPasteboard) -> Option<PathBuf> {
    let classes: Retained<NSArray<AnyClass>> = NSArray::from_slice(&[NSURL::class()]);
    let yes = NSNumber::new_bool(true);
    // SAFETY: 系统常量；值为 NSNumber。
    let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
        &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
        &[yes.as_ref()],
    );
    // SAFETY: 类数组里只有 NSURL，选项是读取文件地址的标准写法。
    let objs = unsafe { pboard.readObjectsForClasses_options(&classes, Some(&options)) }?;
    objs.iter()
        .find_map(|o| o.downcast::<NSURL>().ok())
        .and_then(|url| url.to_file_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardTypeString, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use std::path::Path;

    /// 私有剪贴板，离开作用域时释放。
    struct Board(Retained<NSPasteboard>);

    impl Board {
        fn new() -> Self {
            let pb = NSPasteboard::pasteboardWithUniqueName();
            pb.clearContents();
            Board(pb)
        }
    }

    impl Drop for Board {
        fn drop(&mut self) {
            // SAFETY: `releaseGlobally` 无参数、无返回值。
            let _: () = unsafe { msg_send![&*self.0, releaseGlobally] };
        }
    }

    #[test]
    fn 读出写入的文件地址() {
        let board = Board::new();
        let path = Path::new("/tmp/glance svc/图.png");
        let url = NSURL::from_file_path(path).unwrap();
        let objs: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>> =
            NSArray::from_slice(&[ProtocolObject::from_ref(&*url)]);
        assert!(board.0.writeObjects(&objs));
        assert_eq!(first_path(&board.0), Some(path.to_path_buf()));
    }

    #[test]
    fn 空剪贴板没有路径() {
        let board = Board::new();
        assert_eq!(first_path(&board.0), None);
    }

    #[test]
    fn 纯文本不算路径() {
        let board = Board::new();
        let text = NSString::from_str("/tmp/glance svc/图.png");
        // SAFETY: 系统常量。
        assert!(board
            .0
            .setString_forType(&text, unsafe { NSPasteboardTypeString }));
        assert_eq!(first_path(&board.0), None);
    }
}
