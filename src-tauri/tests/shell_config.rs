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
