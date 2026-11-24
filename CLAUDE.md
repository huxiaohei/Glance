# Glance 项目约定

Glance 是 Tauri 2 + Rust + React 的本地看图工具（macOS 与 Windows）。动手前先读：

- `docs/Glance产品策划文档.md`：产品需求
- `docs/Glance技术方案.md`：技术方案，是实现的依据；标［默认］的是已定的默认决定，标［待验证］的要等 M0 实验结论
- `docs/plans/`：各阶段实施计划

## 提交规范

- **提交日志里不得出现任何 Claude 或 AI 相关信息**：不加 `Co-Authored-By`，不加“Generated with …”，正文也不提。PR 描述同理。
- 提交信息用中文，带类型前缀：`feat:`、`fix:`、`chore:`、`docs:`、`ci:`、`test:`、`refactor:`，可带范围如 `feat(imaging):`。
- 未经用户明确同意，不推送、不打标签、不发布。
- 不提交 `fixtures/`、`.superpowers/`、密钥文件。

## 常用命令

```bash
npm run tauri dev                              # 开发模式启动
cargo test --workspace                         # Rust 测试
cargo clippy --workspace -- -D warnings        # Rust 静态检查
npm test                                       # 前端测试（Vitest）
npx tsc --noEmit                               # 类型检查
cargo run --release -p gen-fixtures -- <preset> --out fixtures/<preset>   # 生成样张：transport | huge | many | oriented
cargo test -p glance --test trash_roundtrip -- --ignored                  # 废纸篓测试（会动真实废纸篓）
cargo test -p glance --test watch_live -- --ignored                       # 目录监听端到端测试（真实文件事件，合并前必跑）
```

每次改动结束前，前四条检查必须全部通过。

## 工程结构

- Cargo 工作区：`src-tauri`（包名 `glance`，库名 `glance_lib`）、`crates/glance-imaging`（纯图片库，不依赖 Tauri）、`tools/gen-fixtures`。
- 前端在 `src/`：`app/` 打开流程，`ipc/` 通信封装，`stores/` 状态（zustand），`lib/` 纯函数，`views/` 视图，`lab/` 实验面板，`i18n/` 界面文字。
- 目录变化走同一套带 `generation` 的事件：`batch` 是 upsert（新增和内容变化都用它），另有 `removed`、`renamed`、`watchFailed`。后端 `catalog/reconcile.rs` 负责把磁盘状态与已知条目比对，`catalog/watch.rs` 是监听器与每个会话一条的线程。
- 缩略图地址的 `?v=` 取自就绪状态（ready），不取自条目。
- 单张视图（V0.1-B）：`stores/{nav,singleUi}.ts`、`lib/{viewport,preloadPlan,currentImage,stripLayout,formatBytes,perfMarks}.ts`、`views/single/`（SingleView、Stage + useStageViewport、preloader、Filmstrip、TopBar、InfoBar、DetailsPanel、useIdle、singleCommands）、`app/fullscreen.ts`；后端 `src-tauri/src/catalog/details.rs`（按 EXIF 方向换算的显示尺寸、`image_details`）；缩略图队列里有“进行中”集合；实验面板有“切图”页（P50 / P95）。
- 前端新增：`app/{commands,keys,useKeyboard,appCommands,useImageList}.ts`、`stores/{selection,gridCtx}.ts`、`lib/{selection,marquee}.ts`、`views/help/`（快捷键一览）、`views/grid/{gridCommands,useMarquee}.ts`、`test/setup.ts`。
- 文件操作（V0.1-C）：后端 `src-tauri/src/fileops/{fsx,ops,undo,commands,trash}.rs`（`fsx` 是唯一改名 / 复制的地方，`ops` 是操作与撤销的主体，`undo` 是只记一步的撤销日志，`commands` 是 `fs_*` 命令与最近目标）、`src-tauri/src/system.rs`（剪贴板与“在访达中显示”）；前端 `app/{fileOps,fileCommands,contextMenu,nativeMenu}.ts`、`stores/{toast,rename}.ts`、`views/{toast,common}/`（提示条、重命名输入、名字对话框）、`lib/{lastSegment,menuLabel}.ts`。操作完成后后端把路径提示（`FsHint`）直接投递给会话线程，不等监听器。
- 入口与设置（V0.1-D）：后端 `src-tauri/src/state/{store,settings,recents,session}.rs`（`store` 是唯一读写应用配置目录下小 JSON 的地方，先写临时文件再原子改名；`settings.json` 六项、`recents.json`、`session.json`）、`src-tauri/src/thumbs/sweep.rs`（启动时在后台线程清理缩略图缓存）；前端 `stores/{settings,recents}.ts`、`app/{applySettings,recentsSync,recentsMenu}.ts`、`views/settings/`（设置对话框）、`views/start/RecentList.tsx`（启动页最近目录）、`views/common/useModalFocus.ts`（对话框的焦点陷阱）、`lib/wheelStep.ts`（滚轮切图的累积与节流）。语言切换靠重挂视图树（`App.tsx` 里 `Fragment key={language}`）生效，网格滚动位置和临时界面状态会重置。
- 拖拽（V0.1-C2）：后端 `src-tauri/src/dragout.rs`（`drag_out(ids)`：`FileId` 换路径、用缩略图缓存做预览图、在主线程直接调 `drag` 库，结束经 Channel 通知）；前端 `stores/drag.ts`（拖拽状态）、`lib/thumbDrag.ts`（落点与边缘滚动的纯函数）、`views/grid/{useThumbDrag,DragBadge}`（指针事件拖拽与光标旁徽标）、`app/nativeDrag.ts`（调 `drag_out` 并处理“自己拖出去又拖回”）。移动 / 复制的目标新增 `Dest::Dir`（相对根目录的目录）。已删除原来的拖拽插件及其权限。
- 后端事件可能先于命令应答到达前端，也可能有上一次打开的迟到事件：前端按 `generation` 丢弃过期事件，`openSession` 负责缓冲。
- 包管理器只用 npm；Tauri CLI 通过 `npm run tauri` 调用。

## 硬性约束

- **前端和协议地址里只出现 `FileId`，不出现文件路径。** 路径只在 Rust 侧由 `catalog::registry::Registry` 换算。例外只有实验面板的调试命令，以及三处：仅用于显示的 `RootInfo.path` 和 `ImageDetails.path`，移动 / 复制的目标目录（来自系统对话框或最近目标，含 `OpReport.dest`），以及最近目录的路径（`RecentEntry.path`，只用于显示，并原样传回 `open_path` / `recents_pin` / `recents_remove`）。撤销失败只返回文件名，不返回路径。
- **不向前端开放通用文件系统权限。** 文件访问集中在 `catalog`、`fileops`、`thumbs` 和 `state`（`state` 只读写应用配置目录下自己的文件），不在别处直接碰磁盘（也是为将来上架 Mac App Store 的沙盒预留）。
- **内容安全策略禁止一切远程资源**；图片只允许 `glance:` 与 `http://glance.localhost`。只有 `devCsp` 为开发热更新放宽，正式 `csp` 不得放宽。
- **读文件和 CPU 密集任务不上主线程。** 已接受的例外：设置、最近目录、最近目标三份小配置文件在启动时（`setup` 里、窗口显示之前）读一次。
- **所有写文件的操作先写同目录临时文件，再原子改名。** 任何情况下不静默覆盖用户文件；改名、移动、复制只在 `fileops/fsx.rs` 里做（目标已存在即失败，不“先检查再改名”）。
- **第三方依赖只用宽松许可**（MIT、Apache-2.0、BSD、ISC、Zlib、IJG 等），不引入 GPL / LGPL / AGPL。新增依赖时核对许可证。
- **所有快捷键都登记在 `src/app/commands.ts` 的命令表里**，不要另外加零散的 keydown 监听（已有例外：框选与拖拽进行中的 Esc）。输入控件聚焦时只有标了 `allowInInput` 的命令响应。
- **界面文字一律走 `src/i18n/`**，不在组件里写死中文或英文；`zh-CN.ts` 与 `en.ts` 必须同步。实验面板除外。
- **单张视图用 `FileId` 记位置，不用下标**；解码好的图只来自预加载器，迟到的解码结果只有 id 和地址仍一致才显示。
- **画面用直接写进 DOM 的 transform 布局**，热路径上不走 React 状态。
- 窗口权限（capabilities）只为全屏增加了两项，另有 `dialog:allow-open`；没有拖拽权限（拖出由后端命令完成）。
- 最低系统：macOS 12、Windows 10。
- 依赖版本锁在 `Cargo.lock` 和 `package-lock.json` 里并提交。

## 开发方式

- 先写失败的测试，再写实现。
- 格式化只对自己改的叶子文件跑 `rustfmt`：对 `lib.rs` 或 `mod.rs` 跑会连带格式化子模块。
- 组件和 hook 的测试写成 `*.test.tsx`，文件第一行是 `// @vitest-environment jsdom`。
- 实验面板（`src/lab/`、`src-tauri/src/lab.rs`）只在调试构建里编译和注册，正式功能不得依赖它。
- 废纸篓测试只能操作测试自己在临时目录里创建的文件，不得清空废纸篓或动其他文件。
- 无法目视确认的界面行为（窗口显示、拖拽、实验读数）要明确说明“未验证”，并给出人工检查步骤，不要写成已通过。

## 当前进度

- M0：任务 1 到 6 完成；任务 7（CI、出包、更新）和任务 8 的 Windows 部分未做，等待推送许可。
- V0.1-A1 完成：打开目录、分组缩略图网格、排序筛选、目录树。
- V0.1-A2 完成：目录监听、选中与多选、键盘导航、命令表、快捷键一览。合并前须手动运行 `watch_live`（见上）。
- V0.1-B 完成：单张视图（缩放平移、预加载切图、缩略图条、详情面板、全屏）。
- V0.1-C 完成：删除（可撤销）、重命名、移动 / 复制（含新建子目录、重名跳过与“保留两者”）、右键菜单、剪贴板与在访达中显示、提示条。Windows 分支未编译，界面未目视确认（清单见后续事项）。
- V0.1-D 完成：启动页（最近目录、固定、移除）、设置（主题、语言、默认排序、包含子目录、滚轮、到头循环）、浅色主题、中英文切换、窗口状态保存、缩略图缓存淘汰、详情与顶栏等细节。界面已由用户试用确认；Windows 分支未编译。
- V0.1-C2 完成：缩略图拖到目录树移动（按住 Option / Ctrl 为复制）、拖出窗口交给其他应用、已选多张时按下不再立刻收成单选。拖拽行为尚未在真实窗口里目视确认，Windows 分支未编译（清单见后续事项“目视确认”）。
- 下一步：V0.1-D2（系统集成，随出包一起做），由用户决定。写计划前先读 `docs/plans/后续事项.md`。
