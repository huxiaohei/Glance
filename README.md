<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Glance"><br>
  <b>Glance</b> · 以目录为单位的本地看图工具<br>
  <a href="#从源码构建">构建</a> •
  <a href="#项目结构">项目结构</a> •
  <a href="#规划">规划</a> •
  <a href="#常见问题">常见问题</a>
</p>

<p align="center">
  <a href="https://github.com/huxiaohei/Glance/actions/workflows/ci.yml"><img src="https://github.com/huxiaohei/Glance/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/平台-macOS%20%7C%20Windows-blue" alt="平台">
  <img src="https://img.shields.io/badge/价格-免费-brightgreen" alt="免费">
</p>

> [!NOTE]
> Glance 还在开发中，尚未发布安装包。所有功能做完后会在 [Releases](https://github.com/huxiaohei/Glance/releases) 发布 macOS 与 Windows 版本，之后应用会自动提示更新。

打开一个目录，就能连续浏览其中（含子目录）的所有图片，并顺手完成对比和轻量编辑，不用双击一张、关掉、再开下一张。Glance 用 Tauri 2 + Rust + React 写成，图片全部在本地处理。免费使用；如果它帮到了你，可以点启动页右下角的小老虎请它喝杯奶茶。

**已经能做的：**

- **打开**：按钮、拖入文件夹或图片、最近目录；系统里图片的“打开方式”、目录右键“用 Glance 打开”、拖到 Dock 图标；已开着时再次打开由原窗口接手。
- **浏览**：按子目录分组的缩略图网格、目录树、排序与筛选；单击、⌘/Ctrl 单击、Shift 单击、框选和键盘多选；目录在磁盘上的变化自动跟上。
- **单张视图**：相邻图预解码、秒切；以鼠标为中心缩放、拖动平移；缩略图条、信息条、EXIF 详情面板、全屏。
- **文件操作**：移入废纸篓、重命名、移动 / 复制（含新建子目录、重名时“保留两者”），都可撤销；拖到目录树移动，拖出窗口交给其他应用；复制图片与路径。
- **其他**：深色 / 浅色 / 跟随系统主题，中文 / English，快捷键一览（按 `?`），窗口状态与浏览位置在重启后恢复。

## 依赖

- Rust 1.95.0（仓库里的 `rust-toolchain.toml` 会自动选用）
- Node.js 26 与 npm
- macOS 12 及以上：Xcode Command Line Tools
- Windows 10 及以上：Visual Studio 生成工具（MSVC）与 WebView2

第三方依赖只用宽松许可（MIT、Apache-2.0、BSD、ISC、Zlib 等），由 `cargo deny` 在 CI 里检查。

## 从源码构建

### 开发模式

```sh
npm install
npm run tauri dev
```

### 打包

```sh
npm run tauri build
```

macOS 的应用在 `target/release/bundle/macos/Glance.app`，Windows 的安装程序在 `target/release/bundle/nsis/`。本机打包不需要签名密钥；带自动更新包的正式发布由 GitHub Actions 在推送 `v*` 标签时完成。

### 检查与测试

提交前这四项都要通过：

```sh
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm test
npx tsc --noEmit
```

下面两类测试会碰真实的系统环境，默认不运行，需要时显式指定：

```sh
cargo test -p glance --test trash_roundtrip -- --ignored   # 把测试自己建的文件移入废纸篓再放回
cargo test -p glance --test watch_live -- --ignored        # 依赖真实的文件事件
```

测试样张输出到被忽略的 `fixtures/` 目录，`preset` 可取 `transport`、`huge`、`many`、`oriented`：

```sh
cargo run --release -p gen-fixtures -- many --out fixtures/many
```

## 项目结构

- **[src](src)**：前端（React + TypeScript）。`app` 打开流程、命令表与快捷键、文件操作；`stores` 状态；`views` 启动页、网格、单张视图、设置、打赏面板；`lib` 纯函数；`i18n` 界面文字。
- **[src-tauri](src-tauri)**：应用壳与后端（Rust）。`catalog` 扫描、监听与文件登记；`thumbs` 缩略图缓存与调度；`fileops` 文件操作与撤销；`state` 设置与最近目录；`shell` 系统交来的打开请求；`update` 检查更新。
- **[crates/glance-imaging](crates/glance-imaging)**：纯 Rust 图片库（解码、缩略图、编码），不依赖 Tauri。
- **[tools/gen-fixtures](tools/gen-fixtures)**：测试样张生成器。
- **[.github/workflows](.github/workflows)**：`ci.yml` 在 macOS 与 Windows 上跑全部检查；`release.yml` 打标签出包。

## 规划

| 版本 | 主题 | 内容 | 状态 |
|------|------|------|------|
| V0.1 | 看 | 打开目录、分组网格、单张视图、文件操作、系统集成 | 完成，待发布 |
| V0.2 | 比 | 对比篮、可滚动的对比网格、同步缩放 | 未开始 |
| V0.3 | 改 | 压缩、裁剪、去背景、转格式、批量处理 | 未开始 |

## 常见问题

**图片会上传吗？** 不会。图片只在本机读取和处理。唯一的网络请求是正式版启动 3 秒后检查一次更新，可以在设置里关掉。

**macOS 提示“无法验证开发者”？** 目前没有付费签名。到“系统设置 → 隐私与安全性”，点“仍要打开”。

**Windows 弹出 SmartScreen 警告？** 点“更多信息 → 仍要运行”。
