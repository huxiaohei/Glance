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
