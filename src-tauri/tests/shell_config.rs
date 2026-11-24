use glance_lib::catalog::scan::IMAGE_EXTS;

#[test]
fn macos_关联的扩展名与扫描一致() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.macos.conf.json");
    let text = std::fs::read_to_string(path).expect("读取 tauri.macos.conf.json");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let assocs = v["bundle"]["fileAssociations"].as_array().unwrap();

    let mut exts: Vec<String> = assocs
        .iter()
        .flat_map(|a| a["ext"].as_array().unwrap().iter())
        .map(|e| e.as_str().unwrap().to_string())
        .collect();
    exts.sort();
    exts.dedup();
    let mut want: Vec<String> = IMAGE_EXTS.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(exts, want);

    for a in assocs {
        assert_eq!(a["rank"], "Alternate");
        assert_eq!(a["role"], "Viewer");
    }
    assert!(assocs.iter().any(|a| a["contentTypes"]
        .as_array()
        .is_some_and(|c| c.iter().any(|t| t == "public.folder"))));
}

#[test]
fn macos_声明了打开服务() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let plist = std::fs::read_to_string(format!("{dir}/Info.plist")).expect("读取 Info.plist");
    for key in [
        "NSServices",
        "openInGlance",
        "public.folder",
        "public.image",
    ] {
        assert!(plist.contains(key), "Info.plist 缺少 {key}");
    }
    let strings =
        std::fs::read_to_string(format!("{dir}/macos/zh-Hans.lproj/ServicesMenu.strings"))
            .expect("读取 ServicesMenu.strings");
    assert!(strings.contains("用 Glance 打开"));

    let text = std::fs::read_to_string(format!("{dir}/tauri.macos.conf.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        v["bundle"]["macOS"]["files"]["Resources/zh-Hans.lproj/ServicesMenu.strings"],
        "macos/zh-Hans.lproj/ServicesMenu.strings"
    );
}

fn 读钩子() -> String {
    let dir = env!("CARGO_MANIFEST_DIR");
    let bytes = std::fs::read(format!("{dir}/windows/hooks.nsh")).expect("读取 hooks.nsh");
    assert!(
        bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
        "hooks.nsh 须为 UTF-8 带 BOM"
    );
    String::from_utf8(bytes)
        .expect("hooks.nsh 须为 UTF-8")
        .trim_start_matches('\u{feff}')
        .to_string()
}

#[test]
fn windows_钩子覆盖全部扩展名且装卸对称() {
    let hooks = 读钩子();
    for ext in IMAGE_EXTS {
        let key = format!("Software\\Classes\\.{ext}\\OpenWithProgids");
        assert_eq!(hooks.matches(&key).count(), 2, "{ext} 应写一次、删一次");
    }
    assert_eq!(
        hooks.matches("\\OpenWithProgids").count(),
        2 * IMAGE_EXTS.len(),
        "钩子里不得有多余的扩展名"
    );
    for s in [
        "Directory\\shell\\Glance",
        "Directory\\Background\\shell\\Glance",
        "\"%V\"",
        "\"%1\"",
        "用 Glance 打开",
        "Open with Glance",
        "NSIS_HOOK_POSTINSTALL",
        "NSIS_HOOK_PREUNINSTALL",
    ] {
        assert!(hooks.contains(s), "hooks.nsh 缺少 {s}");
    }
    assert!(hooks.matches("DeleteRegKey").count() >= 3);
    assert!(!hooks.contains("HKCR"));
    assert!(!hooks.contains("UserChoice"));
    for line in hooks.lines().filter(|l| l.contains("Software\\Classes\\.")) {
        assert!(
            line.contains("OpenWithProgids"),
            "不得写扩展名键默认值：{line}"
        );
    }

    let dir = env!("CARGO_MANIFEST_DIR");
    let win = std::fs::read_to_string(format!("{dir}/tauri.windows.conf.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&win).unwrap();
    let hook_path = v["bundle"]["windows"]["nsis"]["installerHooks"]
        .as_str()
        .unwrap();
    assert!(std::path::Path::new(dir).join(hook_path).exists());
    let base = std::fs::read_to_string(format!("{dir}/tauri.conf.json")).unwrap();
    let langs = v["bundle"]["windows"]["nsis"]["languages"]
        .as_array()
        .unwrap();
    assert!(langs.iter().any(|l| l == "SimpChinese"));
    assert!(!win.contains("fileAssociations"));
    assert!(!base.contains("fileAssociations"));
}
