# Glance

以“目录”为单位的本地看图工具：打开一个目录，连续浏览其中（含子目录）的所有图片，并顺手完成多图对比和轻量编辑。支持 macOS 与 Windows。

> **当前状态：V0.1 进行中。** 已经可以打开目录（按钮、拖入文件夹或图片、Cmd/Ctrl + O），按子目录分组浏览缩略图，排序、筛选、调缩略图大小；可以单击、Cmd/Ctrl + 单击、Shift + 单击、框选和用键盘选中图片，按 `?` 查看快捷键。双击或按 Enter 进入单张视图，Esc 返回，网格的滚动位置和选中保持不变；直接打开图片文件则直接进入单张视图。单张视图里用 ←/→/Home/End 或两侧箭头切图（相邻图已预解码；不循环，到头和进入另一个目录时有提示）；滚轮以鼠标位置为中心缩放，拖动平移，双击在适应窗口与 100% 间切换，键盘 `+` `−` `0` `1` 同样可用；有顶栏路径、信息条和缩略图条，按 `I` 打开详情面板（含 EXIF），鼠标静止 2 秒后工具栏淡出，按 `F` 全屏，F5 同样可刷新。目录在磁盘上的变化会自动跟上：正在看的图被删除则显示下一张，被改写则无闪烁地刷新。文件操作也已可用：Delete（macOS 为 ⌘⌫）移入废纸篓、F2 或双击文件名重命名、移动 / 复制到所选目录、最近目标或新建子目录（重名时跳过，可选“保留两者”），Cmd/Ctrl + Z 或提示条上的“撤销”撤回最近一次；右键菜单、复制图片 / 路径到剪贴板、在访达（资源管理器）中显示。Windows 上的文件操作尚未实测。启动时有启动页，列出最近打开的目录（可固定、移除，带缩略图，点开恢复上次的排序与看到的图片）；Cmd/Ctrl + , 打开设置：深色 / 浅色 / 跟随系统的主题、中文 / English、打开目录时是否包含子目录、默认排序、到头是否循环、滚轮缩放或切图；窗口大小位置会在重启后恢复，缩略图缓存超过 1 GB 时自动清理。可以把缩略图拖到目录树上移动（拖动中按住 Option / Ctrl 为复制，光标旁显示张数），也可以拖出窗口交给访达、聊天软件等其他应用（拖拽行为尚未在真实窗口里目视确认，Windows 未编译）。还不能做对比和编辑。

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
- 实施计划与实验结论：[docs/plans/](docs/plans/)，其中[后续事项](docs/plans/后续事项.md)记录了已知但尚未处理的问题

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

生成测试样张（输出到被忽略的 `fixtures/` 目录，`preset` 可取 `transport`、`huge`、`many`、`oriented`）：

```bash
cargo run --release -p gen-fixtures -- many --out fixtures/many
```

废纸篓相关的测试会真的把测试自己创建的文件移入系统废纸篓，默认不运行，需要显式指定：

```bash
cargo test -p glance --test trash_roundtrip -- --ignored
```

目录监听的端到端测试依赖系统的文件事件，时序不完全可控，默认不运行，需要显式指定：

```bash
cargo test -p glance --test watch_live -- --ignored
```

## 目录结构

```
Glance/
├─ docs/                    产品策划、技术方案、实施计划
├─ src/                     前端
│  ├─ app/                  打开目录的流程、命令表与键盘分发（commands、keys、useKeyboard、appCommands、useImageList）、全屏（fullscreen）、文件操作与右键菜单（fileOps、fileCommands、contextMenu、nativeMenu）、拖出窗口（nativeDrag）
│  ├─ ipc/                  与后端通信的类型和封装
│  ├─ stores/               状态（条目、列表选项、缩略图、选中、网格上下文、导航 nav、单张视图界面 singleUi、提示条 toast、重命名 rename、拖拽 drag）
│  ├─ lib/                  纯函数（列表派生、网格布局、选中逻辑、框选、自然排序、视口 viewport、预加载计划 preloadPlan、currentImage、stripLayout、formatBytes、perfMarks 等）
│  ├─ views/                启动页、网格视图（含选中与框选）、单张视图（single：舞台与缩放、预加载、缩略图条、顶栏、信息条、详情面板）、快捷键一览（help）、提示条（toast）与重命名 / 名字对话框（common）
│  ├─ lab/                  实验面板（仅开发构建可见）
│  ├─ i18n/                 界面文字（中文、英文）
│  └─ test/                 测试公共设置（setup.ts）
├─ src-tauri/               应用壳与后端
│  └─ src/
│     ├─ catalog/           文件登记、目录扫描、打开会话与事件、磁盘状态比对（reconcile）、目录监听（watch）、详情与按 EXIF 方向换算的显示尺寸（details）
│     ├─ thumbs/            缩略图缓存、调度与工作线程
│     ├─ commands.rs        供界面调用的命令
│     ├─ protocol.rs        glance:// 协议，向界面提供原图和缩略图
│     ├─ fileops/           文件操作：改名 / 复制原语（fsx）、操作与撤销（ops、undo）、废纸篓（trash）、界面命令（commands）
│     ├─ system.rs          剪贴板与“在访达中显示”
│     ├─ dragout.rs         拖出窗口：按 FileId 发起系统拖拽
│     └─ lab.rs             实验用命令（仅调试构建）
├─ crates/glance-imaging/   纯 Rust 图片库（编码器、缩略图生成），不依赖 Tauri
└─ tools/gen-fixtures/      测试样张生成器
```

## 实验面板

开发模式下，启动页右下角有“实验面板”入口，包含传输、缓存、大图、废纸篓、拖拽、切图六个页签（切图页显示切图耗时的 P50 / P95），用来验证技术方案里尚未确认的判断。各页的操作方法和通过标准见 M0 实施计划。

## 隐私

全部在本地处理，不上传任何图片。
