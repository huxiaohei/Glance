# Glance

以“目录”为单位的本地看图工具：打开一个目录，连续浏览其中（含子目录）的所有图片，并顺手完成多图对比和轻量编辑。支持 macOS 与 Windows。

> **当前状态：M0（地基与验证）进行中。** 现在只有工程骨架、几块底层能力和一个用于技术验证的“实验面板”。启动页上的“打开目录”按钮和拖入目录还没有接上功能，它们属于 V0.1。

## 规划

| 版本 | 主题 | 内容 |
|------|------|------|
| M0 | 地基 | 工程骨架、双平台出包与更新、六项技术实验 |
| V0.1 | 看 | 打开目录、子目录分组、网格与单张视图、秒切、文件操作 |
| V0.2 | 比 | 对比篮、可滚动的对比网格、同步缩放 |
| V0.3 | 改 | 压缩、裁剪、去背景、转格式、批量处理 |

详见：

- [产品策划文档](docs/Glance产品策划文档.md)
- [技术方案](docs/Glance技术方案.md)
- [M0 实施计划](docs/plans/2026-11-22-M0-地基与验证.md)

## 技术栈

- 外壳：Tauri 2
- 后端：Rust（扫描、缩略图、文件操作、图片处理）
- 前端：React + TypeScript + Vite
- 测试：`cargo test`、Vitest

## 环境要求

- Rust（稳定版）
- Node.js 与 npm
- macOS：Xcode Command Line Tools；Windows：MSVC 生成工具与 WebView2

## 常用命令

安装依赖：

```bash
npm install
```

以开发模式启动应用：

```bash
npm run tauri dev
```

运行全部检查：

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm test
npx tsc --noEmit
```

生成测试样张（输出到被忽略的 `fixtures/` 目录，`preset` 可取 `transport`、`huge`、`many`）：

```bash
cargo run --release -p gen-fixtures -- many --out fixtures/many
```

废纸篓相关的测试会真的把测试自己创建的文件移入系统废纸篓，默认不运行，需要显式指定：

```bash
cargo test -p glance --test trash_roundtrip -- --ignored
```

## 目录结构

```
Glance/
├─ docs/                    产品策划、技术方案、实施计划
├─ src/                     前端
│  ├─ lib/                  纯函数（地址拼接、拖拽判定等）
│  ├─ lab/                  实验面板（仅开发构建可见）
│  └─ i18n/                 界面文字（中文、英文）
├─ src-tauri/               应用壳与后端
│  └─ src/
│     ├─ catalog/           文件登记（FileId ↔ 路径）
│     ├─ protocol.rs        glance:// 协议，向界面提供图片字节
│     ├─ fileops/           文件操作（移入废纸篓与放回）
│     └─ lab.rs             实验用命令（仅调试构建）
├─ crates/glance-imaging/   纯 Rust 图片库（编码器），不依赖 Tauri
└─ tools/gen-fixtures/      测试样张生成器
```

## 实验面板

开发模式下，启动页右下角有“实验面板”入口，包含传输、缓存、大图、废纸篓、拖拽五个页签，用来验证技术方案里尚未确认的判断。各页的操作方法和通过标准见 M0 实施计划。

## 隐私

全部在本地处理，不上传任何图片。
