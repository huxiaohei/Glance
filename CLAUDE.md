# Glance 项目约定

Glance 是 Tauri 2 + Rust + React 的本地看图工具（macOS 与 Windows）。动手前先读：

- `docs/Glance产品策划文档.md`：产品需求
- `docs/Glance技术方案.md`：技术方案，是实现的依据；标［默认］的是已定的默认决定，标［待验证］的要等 M0 实验结论
- `docs/plans/`：各阶段实施计划

## 提交规范

- **提交日志里不得出现任何 Claude 或 AI 相关信息**：不加 `Co-Authored-By`，不加“Generated with …”，正文也不提。PR 描述同理。
- 提交信息用中文，带类型前缀：`feat:`、`fix:`、`chore:`、`docs:`、`ci:`、`test:`、`refactor:`，可带范围如 `feat(imaging):`。
- 未经用户明确同意，不推送、不打标签、不发布。**所有功能（V0.1 到 V0.3）做完之前不发布**（用户 2026-11-24 决定），签名密钥与首次发布（V0.1-D2 任务 11）留到那时。
- 不提交 `fixtures/`、`.superpowers/`、密钥文件。
- **`docs/` 只留在本机，不进 git**（已在 `.gitignore` 里），历史里也不得出现；提交信息与 README 不要链接 `docs/` 下的文件。2026-11-24 已从全部历史中剔除并重建远端仓库，备份在 `.superpowers/backup-2026-11-24/`。

## 常用命令

```bash
npm run tauri dev                              # 开发模式启动
npm run tauri build -- --bundles app           # 本机打 macOS 应用包（不需要签名密钥）
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
- 入口与设置（V0.1-D）：后端 `src-tauri/src/state/{store,settings,recents,session}.rs`（`store` 是唯一读写应用配置目录下小 JSON 的地方，先写临时文件再原子改名；`settings.json` 十三项（V0.1-D 六项，V0.1-D2 加“检查更新”，V0.2-A 加对比三项与“显示快捷键提示”，V0.3-A 加“默认保存方式” `editSaveMode`，V0.3-C 加“批量输出目录” `batchOutputDir`，默认 `_glance_output`）、`recents.json`、`session.json`（最近目标 `recentTargets`、V0.2-B 的 `basket` 与 V0.3-A 的 `editParams`（压缩 / 转格式页上次保存用的参数，V0.3-B 加 `crop` / `removeBg`）；窗口状态由 `tauri-plugin-window-state` 自己保存，不在这里））、`src-tauri/src/thumbs/sweep.rs`（启动时在后台线程清理缩略图缓存）；前端 `stores/{settings,recents}.ts`、`app/{applySettings,recentsSync,recentsMenu}.ts`、`views/settings/`（设置对话框）、`views/start/RecentList.tsx`（启动页最近目录）、`views/common/useModalFocus.ts`（对话框的焦点陷阱）、`lib/wheelStep.ts`（滚轮切图的累积与节流）。语言切换靠重挂视图树（`App.tsx` 里 `Fragment key={language}`）生效，网格滚动位置和临时界面状态会重置。
- 拖拽（V0.1-C2）：后端 `src-tauri/src/dragout.rs`（`drag_out(ids)`：`FileId` 换路径、用缩略图缓存做预览图、在主线程直接调 `drag` 库，结束经 Channel 通知）；前端 `stores/drag.ts`（拖拽状态）、`lib/thumbDrag.ts`（`dragIds`、`transferPlan`、`copyModifier`、`selectModifier` 四个纯函数；目录树的边缘滚动沿用 `lib/marquee.ts` 的 `edgeScroll`）、`lib/dragOut.ts`（是否该转为系统拖拽：边缘 4 px 判断，以及目录树一栏上要出了视口才算）、`views/grid/{useThumbDrag,DragBadge}`（指针事件拖拽与光标旁徽标）、`app/nativeDrag.ts`（调 `drag_out` 并处理“自己拖出去又拖回”）。移动 / 复制的目标新增 `Dest::Dir`（相对根目录的目录）。已删除原来的拖拽插件及其权限。
- 系统集成与出包（V0.1-D2）：后端 `src-tauri/src/{shell,macos_service,update}.rs`（`shell::submit` 是系统交来路径的唯一入口，前端经 `take_open_request` 取走后走 `openFolder`）；平台声明 `src-tauri/{tauri.macos.conf.json,Info.plist,tauri.windows.conf.json,windows/hooks.nsh}`，`catalog::scan::IMAGE_EXTS` 是扩展名的唯一出处（`tests/shell_config.rs` 比对）；`tauri.release.conf.json` 只在发布流程里带上；`.github/workflows/{ci,release}.yml`、`deny.toml`；前端 `app/{openRequests,updateCheck}.ts`、`stores/tip.ts`、`views/tip/`（打赏面板）、启动页探头小老虎（`assets/tip/`）。
- 对比（V0.2-A）：前端 `stores/{basket,compareUi}.ts`（对比篮：有序去重的 `FileId` 列表，换目录不清空；对比视图的焦点、缩放与同步状态）、`lib/{basket,compareViewport}.ts`（纯函数；多格共享视口的数学都在 `compareViewport.ts`，缩放锚点一律按未夹位置换算，结果再夹到范围内）、`app/{singleSource,basketCommands}.ts`（单张视图的来源 `source: "folder" | "basket"`，来源为篮时左右键只在篮里切；空格 / C 命令）、`views/compare/`（CompareView、格子、顶栏、对比命令与操作；滚出视口的格子摘掉原图）；后端 `basket_check`（`catalog/details.rs` + `commands.rs`，核对篮里的图是否还在，只返回文件名，不返回路径）。热路径（同步缩放平移）只在 rAF 里直接写各格 transform，不走 React 状态。设置新增 `compareColumns`、`compareSyncOnEnter`、`compareBackground`。
- 对比排序、添加面板与重启保留（V0.2-B）：后端 `state/session.rs` 的 `SessionStore` 是 `session.json` 的唯一写入者（最近目标 `recentTargets` 与 `basket` 路径列表共用一份，互不覆盖）；`src-tauri/src/basket.rs` 三个命令：`basket_save`（对比篮按序存路径）、`basket_restore`（启动后读回并登记成 `FileId`，缺失的文件也带回，前端显示占位）、`browse_dir`（面板“其他文件夹…”只扫一层，返回条目快照）。前端 `app/basketPersist.ts`（启动时恢复、对比篮变化后防抖保存、`pagehide` 时立即保存）、`lib/dragSort.ts`（排序拖动的纯函数）与 `views/compare/compareDragSort.ts`（指针事件拖动、让位动画；放大的格子拖动是平移不排序）、`lib/panelSource.ts`（面板的来源：当前文件夹 / 子文件夹 / 其他文件夹，纯函数）、`views/compare/ComparePanel.tsx`（右侧添加面板，大量图片时虚拟滚动）；`compareUi` 新增 `panelOpen`、`panelSource`、`otherDir`、`focusArea`（`"wall" | "panel"`）、`panelFocus`。Alt+方向键交换相邻（`compare.move*`），Tab 开合面板（`compare.togglePanel`：面板已开但焦点在墙时先把焦点移进面板，焦点在面板时才收起），面板区空格 / Enter 加入或移出，Esc 先回墙再返回；快捷键提示在焦点进面板后换成面板的三条。
- 编辑：压缩与转格式（V0.3-A）：`crates/glance-imaging/src/{quantize,edit}.rs`（`quantize` 用 color_quant NeuQuant 按 alpha 分组量化，有损 PNG 经 oxipng RawImage 写索引色；`edit::apply` 是预览与保存共用的唯一实现；PNG / JPEG 保留 ICC，WebP 丢弃）；后端 `src-tauri/src/edit/{mod,session,worker,commands}.rs`（同一时刻一个编辑会话；解码后缩成 ≤2048 的代理图；拖动预览 JPEG / WebP ≤1024、PNG ≤512；工作线程只做最新请求，`rev` 单调防迟到；结果走 `glance://edit/{session}/{rev}`，no-store）、`src-tauri/src/fileops/edit_save.rs`（另存副本 `_compressed` / `_converted` / 新扩展名，重名加 `_2`…；覆盖 = 原图进废纸篓再原子改名，保留权限；“另存到其他位置”永不覆盖；撤销是 `OpKind::Edit`）。前端 `stores/{editUi,animated,confirmOverwrite}.ts`、`lib/editPreview.ts`、`app/editSave.ts`、`views/edit/`（EditLayer、EditPanel、CompressTab、ConvertTab、SaveBar、SizeFooter、ConfirmOverwrite、EditButton、editCommands）；`activeView()` 在编辑中返回 `"edit"`，编辑命令的视图为 `["edit"]`；编辑中的快捷键提示是 `editHints`（保存、取消）。
- 编辑：裁剪与去背景（V0.3-B）：`crates/glance-imaging/src/{crop,removebg}.rs`（`crop` 是裁剪几何与像素裁剪、旋转翻转；`removebg` 是透明度阈值与按颜色两种去背景，含边缘柔化与去色溢、只去与边缘连通区域；按颜色时全透明像素一律算背景，透明边能把连通接到底色上）；后端 `edit_pick`（按图上的点取背景色）与协议路由 `glance://edit/{session}/source`（编辑会话的源图，只供裁剪页的舞台显示；去背景页沿用结果图层）；前端 `lib/cropGeometry.ts`（裁剪框几何的纯函数）、`views/edit/{CropStage,CropTab,RemoveBgTab}.tsx`（裁剪页无缩放，自带舞台）；`lib/editPreview.ts` 的调度器加了 `proxy` 选项，换页签时调 `cut()` 丢弃上一页在途的结果；裁剪页未做改动时不发预览（`cancel()` 取消待发与在途请求，底栏显示原尺寸）。输出：裁剪保持原格式（GIF / BMP 存 PNG），去背景一律 PNG（覆盖非 PNG 会换成 `.png`，仍可撤销）。
- 批量压缩与转格式（V0.3-C）：后端 `src-tauri/src/batch/{mod,plan,job}.rs`（`batch_plan` 只读文件头判断跳过规则；`batch_start` / `batch_cancel`：1 到 4 条 `glance-batch-N` 工作线程，进度经 Channel 节流发送，取消后已完成的保留；整批只记一步撤销 `OpKind::Batch`，撤销时把输出文件进废纸篓并删掉新建的空目录）、`src-tauri/src/edit/render.rs`（`read_source`、`render_path`，单张保存与批量共用）、`fileops/edit_save.rs::write_new`；输出到 `根目录/<输出目录>/<相对路径>`，沿用原名、扩展名取输出格式、不加后缀，重名加 `_2`；跳过：压缩时的 GIF / BMP、动图、已在输出目录里的文件。前端 `stores/batch.ts`、`app/batchToast.ts`（提示条里的进度，500 ms 后出现“取消”，结束后留一条带详情与“撤销”的汇总；`updateToast`、`ToastAction.keep`）、`app/batchMode.ts`（单张视图来源新增 `"selection"`，`editUi.batch`，压缩 / 转格式两页，按钮“处理 N 张”，方向键、滚轮、缩略图条只在选中的图里切，Enter 开始，Esc 回网格）、`lib/batchDirName.ts`、设置对话框里的输出目录；网格入口：状态栏“压缩 / 转格式”、右键菜单“批量压缩… / 批量转格式…”、网格里按 E（`grid.edit`），批量运行中这些入口禁用。
- 帮助：`views/help/ShortcutsOverlay.tsx`（`?` 打开；“快捷键”页由命令表生成，“鼠标”页是静态清单，修饰键按平台显示），入口在网格工具栏右端与启动页右下角。
- 快捷键提示：`lib/keyHints.ts`（按状态选出最多三条，纯函数）、`views/common/KeyHints.tsx`（键名取自命令表，命令未注册的那条不显示）；显示在网格状态栏、单张信息条与对比视图底部提示条，设置 `showKeyHints` 可关。
- 后端事件可能先于命令应答到达前端，也可能有上一次打开的迟到事件：前端按 `generation` 丢弃过期事件，`openSession` 负责缓冲。
- 包管理器只用 npm；Tauri CLI 通过 `npm run tauri` 调用。

## 硬性约束

- **前端和协议地址里只出现 `FileId`，不出现文件路径。** 路径只在 Rust 侧由 `catalog::registry::Registry` 换算。例外只有实验面板的调试命令、系统交来的打开路径（`take_open_request`，原样传给 `open_path`），以及下列几处：仅用于显示的 `RootInfo.path` 和 `ImageDetails.path`，移动 / 复制的目标目录（来自系统对话框或最近目标，含 `OpReport.dest`），编辑“另存到其他位置”由系统保存对话框选出的目标路径（原样传给 `edit_save`，不持久化），对比面板“其他文件夹…”里由系统对话框选中的目录（原样传给 `browse_dir`，留在 `compareUi.otherDir`，不持久化），以及最近目录的路径（`RecentEntry.path`，只用于显示，并原样传回 `open_path` / `recents_pin` / `recents_remove`）。撤销失败只返回文件名，不返回路径。
- **不向前端开放通用文件系统权限。** 文件访问集中在 `catalog`、`fileops`、`thumbs` 和 `state`（`state` 只读写应用配置目录下自己的文件）；已有的例外是 `system.rs`（读图复制到剪贴板）与 `dragout.rs`（检查文件是否存在、读缩略图缓存后把路径交给系统拖拽），二者只按 `FileId` 读取，不写文件；不在别处直接碰磁盘（也是为将来上架 Mac App Store 的沙盒预留）。
- **内容安全策略禁止一切远程资源**；图片只允许 `glance:` 与 `http://glance.localhost`。只有 `devCsp` 为开发热更新放宽，正式 `csp` 不得放宽。
- **读文件和 CPU 密集任务不上主线程。** 已接受的例外：设置、最近目录、最近目标三份小配置文件在启动时（`setup` 里、窗口显示之前）读一次。
- **所有写文件的操作先写同目录临时文件，再原子改名。** 任何情况下不静默覆盖用户文件；改名、移动、复制只在 `fileops/fsx.rs` 里做（目标已存在即失败，不“先检查再改名”）。
- **第三方依赖只用宽松许可**（MIT、Apache-2.0、BSD、ISC、Zlib、IJG 等），不引入 GPL / LGPL / AGPL。新增依赖时核对许可证。
- **所有快捷键都登记在 `src/app/commands.ts` 的命令表里**，不要另外加零散的 keydown 监听（已有例外：框选与拖拽进行中的 Esc）。输入控件聚焦时只有标了 `allowInInput` 的命令响应。
- **界面文字一律走 `src/i18n/`**，不在组件里写死中文或英文；`zh-CN.ts` 与 `en.ts` 必须同步。实验面板除外。
- **单张视图用 `FileId` 记位置，不用下标**；解码好的图只来自预加载器，迟到的解码结果只有 id 和地址仍一致才显示。
- **画面用直接写进 DOM 的 transform 布局**，热路径上不走 React 状态。
- 窗口权限（capabilities）只为全屏增加了两项，另有 `dialog:allow-open` 与 `dialog:allow-save`（编辑另存）；没有拖拽权限（拖出由后端命令完成）。更新器在 Rust 侧，不占窗口权限。
- 唯一的网络请求是正式构建启动 3 秒后检查一次更新（设置里可关），失败静默。
- Rust 版本由 `rust-toolchain.toml` 固定为 1.95.0，两个工作流里 `dtolnay/rust-toolchain` 同版本；升级时三处一起改。
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

- M0：任务 1 到 6 完成；任务 7 已由 V0.1-D2 完成（实验面板进测试包除外）；任务 8 的 Windows 部分未做。
- V0.1-A1 完成：打开目录、分组缩略图网格、排序筛选、目录树。
- V0.1-A2 完成：目录监听、选中与多选、键盘导航、命令表、快捷键一览。合并前须手动运行 `watch_live`（见上）。
- V0.1-B 完成：单张视图（缩放平移、预加载切图、缩略图条、详情面板、全屏）。
- V0.1-C 完成：删除（可撤销）、重命名、移动 / 复制（含新建子目录、重名跳过与“保留两者”）、右键菜单、剪贴板与在访达中显示、提示条。Windows 分支未编译，界面未目视确认（清单见后续事项）。
- V0.1-D 完成：启动页（最近目录、固定、移除）、设置（主题、语言、默认排序、包含子目录、滚轮、到头循环）、浅色主题、中英文切换、窗口状态保存、缩略图缓存淘汰、详情与顶栏等细节。界面已由用户试用确认；Windows 分支未编译。
- V0.1-C2 完成：缩略图拖到目录树移动（按住 Option / Ctrl 为复制）、拖出窗口交给其他应用、已选多张时按下不再立刻收成单选。界面已由用户在 macOS 上试用确认；Windows 分支未编译（清单见后续事项“目视确认”）。
- V0.1-D2 完成（发布除外）：系统交来的打开请求（启动参数、单实例转交、macOS 打开事件与系统服务）、macOS 文件关联、Windows 安装器注册表钩子、自动更新（Rust 侧，`update_check` / `update_install`，Cargo 特性 `updater`）、双平台 CI 与打标签出包、许可证检查、打赏面板与启动页探头小老虎、新应用图标。打包后的应用在 macOS 上验证了冷启动、二次打开、打开图片；CI 在 macOS 与 Windows 上全绿。服务菜单、“打开方式”、拖到 Dock、更新流程、Windows 上的实际表现未目视确认。
- V0.2-A 完成：对比篮（空格加入 / 移出，换目录保留）、对比视图（同步缩放平移、焦点与键盘操作、移出与清空可撤销、缺失文件占位、按需加载原图）、单张视图可从篮进入、设置里“对比”三项、快捷键一览。均由 jsdom 测试覆盖；真实窗口下的缩放手感、30 张掉帧、滚出视口摘原图、悬停按钮、右键菜单等未目视确认（清单见后续事项“V0.2-A（对比）目视确认”）。
- V0.2-B 完成：对比里拖动排序（未放大时）、Alt+方向键交换相邻、右侧添加面板（Tab；当前文件夹 / 子文件夹 / 其他文件夹一层；点选或空格加入移出、方向键移焦点、Esc 回墙）、对比篮重启保留（路径存 `session.json`，缺失文件显示占位）、面板区快捷键提示。均由 jsdom 与 Rust 测试覆盖；拖动手感与让位动画、边缘自动滚动、面板 2000+ 张滚动、30 张拖动掉帧、重启恢复、Windows 上 Alt+方向键副作用等未目视确认（清单见后续事项“V0.2-B（排序、添加面板、重启保留）目视确认”）。
- V0.3-A 完成：编辑框架（E 进入，Enter 保存，Esc 取消）、压缩（质量、最长边、PNG 有损 / 无损）、转格式（JPEG / PNG / WebP、透明底色）、实时预览与大小预估、另存副本 / 覆盖原图（进废纸篓，可撤销）/ 另存到其他位置、编辑参数记忆、设置“默认保存方式”、快捷键提示与一览。由 jsdom 与 Rust 测试覆盖；真实窗口下的拖动流畅度、面板滑入、按住看原图、PNG 有损画质、覆盖确认与另存对话框、Windows 上的全部表现等未目视确认（清单见后续事项“V0.3-A（编辑：压缩与转格式）目视确认”）。
- V0.3-B 完成：裁剪（拖框与 8 个控制点、Shift 锁比例、比例预设与自定义、宽高输入、旋转翻转、还原）、去背景（透明度阈值、按颜色吸管取色、容差、边缘柔化与去色溢、只去连通区域、棋盘格显示）、输出规则（裁剪保持原格式，去背景一律 PNG，副本 `_cropped` / `_nobg`）、参数记忆。由 jsdom 与 Rust 测试覆盖；真实窗口下的裁剪框手感、吸管位置（含 EXIF 旋转的照片）、软边效果、拖滑块流畅度、6000×4000 全尺寸体积出来的时间、Windows 上的全部表现等未目视确认（清单见后续事项“V0.3-B（裁剪与去背景）目视确认”）。
- V0.3-C 完成：选中多张后批量压缩 / 转格式（网格状态栏、右键菜单或 E 进入；批量模式里左右键在选中的图之间预览参数）、输出到根目录下的输出目录（默认 `_glance_output`，保留相对路径与原名）、按文件头预判跳过、进度条与取消（已完成的保留）、汇总详情、整批一键撤销、设置“批量输出目录”。由 jsdom 与 Rust 测试覆盖；真实窗口下的进度条与取消、几百张大图时的内存与交互流畅度、批量中切图与缩略图是否卡、汇总详情很长时的滚动、撤销后目录树刷新、Windows 上的全部表现等未目视确认（清单见后续事项“V0.3-C（批量压缩与转格式）目视确认”）。
- 发布前收尾：Windows 回收站放回改为按回收站项标识查找（覆盖保存撤销的阻塞项，CI 的 Windows 任务跑 `trash_roundtrip --ignored` 验证）；快捷键一览扩成“帮助”（快捷键 / 鼠标两页，网格工具栏与启动页有入口）；README 精简为“功能”一节并配截图（`assets/readme/`）。
- 下一步：选定 LICENSE、首次发布（V0.1-D2 任务 11）。
