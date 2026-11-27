# Glance 项目约定

Glance 是 Tauri 2 + Rust + React 的本地看图工具（macOS 与 Windows）。动手前先读：

- `docs/Glance产品策划文档.md`：产品需求
- `docs/Glance技术方案.md`：技术方案，是实现的依据；标［默认］的是已定的默认决定，标［待验证］的要等 M0 实验结论
- `docs/README.md`：文档总览与两期的进度汇总，先看这一页
- `docs/第一期/`：V0.1 到 V0.3 的设计与实施计划（已完成，存档）
- `docs/第二期/`：V1.1 的需求（`V1.1-<段>-需求-*.md`），设计与实施计划写出来后也放这里
- `docs/后续事项.md`：遗留问题、目视确认清单、测试缺口；写新计划前先看，做完一条删一条

## 提交规范

- **提交日志里不得出现任何 Claude 或 AI 相关信息**：不加 `Co-Authored-By`，不加“Generated with …”，正文也不提。PR 描述同理。
- 提交信息用中文，带类型前缀：`feat:`、`fix:`、`chore:`、`docs:`、`ci:`、`test:`、`refactor:`，可带范围如 `feat(imaging):`。
- 未经用户明确同意，不推送、不打标签、不发布。首次发布（v1.0.0）已在 2026-11-26 完成；之后每次发布仍要用户明确同意。
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
cargo test -p glance-syscodec --test real_samples -- --ignored            # 系统解码真机样张（要先把 HEIC / AVIF 放进 fixtures/heic/，没有则只打印提示）
cargo test --release -p glance-imaging png_stored_timing -- --ignored --nocapture   # 不压缩 PNG 的编码计时（4000×3000）
```

每次改动结束前，前四条检查必须全部通过。

## 工程结构

- Cargo 工作区：`src-tauri`（包名 `glance`，库名 `glance_lib`）、`crates/glance-imaging`（纯图片库，不依赖 Tauri）、`crates/glance-syscodec`（V1.1-A，系统解码 HEIC / HEIF / AVIF，不依赖 Tauri 与 glance-imaging（glance-imaging 仅测试用到））、`tools/gen-fixtures`。支持的格式：PNG、JPEG、WebP、GIF、BMP，加 V1.1-A 的 HEIC、HEIF、AVIF（扩展名的唯一出处仍是 `catalog::scan::IMAGE_EXTS`，现为九项；HEIC 与 AVIF 可裁剪、去背景、转格式，不能压缩）。
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
- 编辑：压缩与转格式（V0.3-A）：`crates/glance-imaging/src/{quantize,edit}.rs`（`quantize` 用 color_quant NeuQuant 按 alpha 分组量化，有损 PNG 经 oxipng RawImage 写索引色；`edit::apply` 是预览与保存共用的唯一实现；PNG / JPEG 保留 ICC；WebP 原先丢弃 ICC，V1.1-A 起带 ICC 与 EXIF）；后端 `src-tauri/src/edit/{mod,session,worker,commands}.rs`（同一时刻一个编辑会话；解码后缩成 ≤2048 的代理图；拖动预览 JPEG / WebP ≤1024、PNG ≤512；工作线程只做最新请求，`rev` 单调防迟到；结果走 `glance://edit/{session}/{rev}`，no-store）、`src-tauri/src/fileops/edit_save.rs`（另存副本 `_compressed` / `_converted` / 新扩展名，重名加 `_2`…；覆盖 = 原图进废纸篓再原子改名，保留权限；“另存到其他位置”永不覆盖；撤销是 `OpKind::Edit`）。前端 `stores/{editUi,animated,confirmOverwrite}.ts`、`lib/editPreview.ts`、`app/editSave.ts`、`views/edit/`（EditLayer、EditPanel、CompressTab、ConvertTab、SaveBar、SizeFooter、ConfirmOverwrite、EditButton、editCommands）；`activeView()` 在编辑中返回 `"edit"`，编辑命令的视图为 `["edit"]`；编辑中的快捷键提示是 `editHints`（保存、取消）。
- 编辑：裁剪与去背景（V0.3-B）：`crates/glance-imaging/src/{crop,removebg}.rs`（`crop` 是裁剪几何与像素裁剪、旋转翻转；`removebg` 是透明度阈值与按颜色两种去背景，含边缘柔化与去色溢、只去与边缘连通区域；按颜色时全透明像素一律算背景，透明边能把连通接到底色上）；后端 `edit_pick`（按图上的点取背景色）与协议路由 `glance://edit/{session}/source`（编辑会话的源图，只供裁剪页的舞台显示；去背景页沿用结果图层）；前端 `lib/cropGeometry.ts`（裁剪框几何的纯函数）、`views/edit/{CropStage,CropTab,RemoveBgTab}.tsx`（裁剪页无缩放，自带舞台）；`lib/editPreview.ts` 的调度器加了 `proxy` 选项，换页签时调 `cut()` 丢弃上一页在途的结果；裁剪页未做改动时不发预览（`cancel()` 取消待发与在途请求，底栏显示原尺寸）。输出：裁剪保持原格式（GIF / BMP 存 PNG），去背景一律 PNG（覆盖非 PNG 会换成 `.png`，仍可撤销）。
- 批量压缩与转格式（V0.3-C）：后端 `src-tauri/src/batch/{mod,plan,job}.rs`（`batch_plan` 只读文件头判断跳过规则；`batch_start` / `batch_cancel`：1 到 4 条 `glance-batch-N` 工作线程，进度经 Channel 节流发送，取消后已完成的保留；整批只记一步撤销 `OpKind::Batch`，撤销时把输出文件进废纸篓并删掉新建的空目录）、`src-tauri/src/edit/render.rs`（`read_source`、`render_path`，单张保存与批量共用）、`fileops/edit_save.rs::write_new`；输出到 `根目录/<输出目录>/<相对路径>`，沿用原名、扩展名取输出格式、不加后缀，重名加 `_2`；跳过：压缩时的 GIF / BMP、动图、已在输出目录里的文件。前端 `stores/batch.ts`、`app/batchToast.ts`（提示条里的进度，500 ms 后出现“取消”，结束后留一条带详情与“撤销”的汇总；`updateToast`、`ToastAction.keep`）、`app/batchMode.ts`（单张视图来源新增 `"selection"`，`editUi.batch`，压缩 / 转格式两页，按钮“处理 N 张”，方向键、滚轮、缩略图条只在选中的图里切，Enter 开始，Esc 回网格）、`lib/batchDirName.ts`、设置对话框里的输出目录；网格入口：状态栏“压缩 / 转格式”、右键菜单“批量压缩… / 批量转格式…”、网格里按 E（`grid.edit`），批量运行中这些入口禁用。
- 更多格式（V1.1-A）：新包 `crates/glance-syscodec`（`decode(bytes, Kind::{Heif, Avif}, max_pixels, max_edge) -> Image`，只收内存字节；macOS 用 ImageIO（`objc2-image-io` 等三个绑定包），`src/macos.rs`，AVIF 要 macOS 13 及以上（项目最低 macOS 12，12 上 AVIF 按缺组件处理）；Windows 用 WIC（`windows` 0.62），`src/windows.rs` 与 `wic_error.rs`（只有创建解码器这一步把“不认识的格式”算作缺组件，其余步骤只有“找不到组件”算，免得一张坏图把整个进程的状态翻成缺组件）；其他平台 `stub.rs` 恒返回 `NoCodec`；`lib.rs` 里 `boxes_complete` 逐个检查顶层盒子的声明长度，截断的文件按读不出处理；完整的 `ftyp`、`meta` 与 `mdat` 都出现后，末尾凑不成盒子的字节当作厂商附加数据（如三星的尾巴）接受，`catch_unwind` 兜住绑定层的 panic）。`crates/glance-imaging`：`heif.rs`（只读文件头：`sniff` 按内容认 HEIC / AVIF、`parse` 读尺寸、`irot` 旋转（不解析 `imir`，镜像交给系统解码器）、是否带透明与动图、EXIF 的位置，探测有上限、不按不可信字段放大资源；特性 `testkit` 把拼 HEIF 样本的辅助导出给其他包的测试，正式构建不开）、`exifblob.rs`（`normalize_exif`：把 EXIF 方向改写为已摆正、按输出尺寸改写像素尺寸、解除缩略图链接，缩略图在末尾就截掉、截不掉就清零，裁剪后的输出不留未裁剪的整幅小图，与仍被引用的数据交叠时返回 `None`；IFD1 本身读不出当作没有缩略图；其余结构有问题就返回 `None`，调用方改为不带 EXIF 输出）、`encode.rs`（JPEG 与 WebP 输出嵌入 EXIF 与 ICC（JPEG 里 EXIF 的 TIFF 部分超过 65527 字节则不带）；手写的不压缩 PNG `encode_png_stored` 一次分配、校验和用 slice-by-16 与车道化的 Adler-32，供显示通道用）、`edit.rs`（`SrcFormat` 加 `Heif`、`Avif`，`apply` 新增 `has_alpha`：压缩对这两种不可用，裁剪无透明出 JPEG 质量 95、有透明出 PNG）。后端 `src-tauri/src/decode.rs` 是唯一解码入口：`heif::sniff` 命中走系统解码，否则走 glance-imaging，只看内容不看扩展名；带每种格式的“组件缺失”状态（`CodecState`，每次打开目录时在 `Sessions::begin` 里重置，让刚装好的组件生效）与显示通道的并发闸门（上限 2，长边上限 `DISPLAY_MAX_EDGE` 8000）。改动处：`protocol.rs`（原图内容是 HEIF / AVIF 时解码成不压缩 PNG 返回，缺组件返回 415）、`thumbs/worker.rs`（`ThumbEvent::NoCodec`，不写缓存）、`catalog/details.rs`（`heif_head` 读尺寸与拍摄信息、`exif_blob` 改收内存字节、`image_status` 返回 `ok / noCodec / broken`）、`edit/{render,session}.rs`（`EditError::NoCodec`，`Source.has_alpha`；单张与批量的 JPEG / WebP 输出带拍摄信息）、`batch/plan.rs`（文件头读 512 字节；压缩时 HEIC / AVIF 跳过为不支持，转格式时缺组件的跳过为 `NoCodec`，每种格式试解一张）、`system.rs`（剪贴板走 `decode::decode`；`open_codec_help(kind)` 在 Windows 打开 Microsoft Store 页，参数只能是枚举 `CodecKind`，地址写死在后端）。前端：`lib/{codecKind,noCompress,scaledDown}.ts`、`stores/thumbs.ts` 新增 `noCodec` 集合（与 `broken` 互斥）、`views/common/NoCodecMark.tsx`（缩略图位置的缺组件占位）、`views/single/StageFailure.tsx`（单张视图原图失败时先问 `image_status`：缺组件显示说明与“如何安装”按钮，否则重试一次再显示“无法读取”）、信息条“已缩小显示”（只对 HEIC / HEIF / AVIF 判断，按长边比较）；缺组件时编辑入口、批量入口与右键菜单项置灰。实验面板新增 `src/lab/HeicLab.tsx` 与调试命令 `lab_heic_probe`（只在调试构建里）。平台声明：`tauri.macos.conf.json` 的文件关联与 `windows/hooks.nsh` 的注册表钩子加上三种扩展名。没有新增设置项与快捷键；没有引入任何 HEVC / AV1 解码库。
- 帮助：`views/help/ShortcutsOverlay.tsx`（`?` 打开；“快捷键”页由命令表生成，“鼠标”页是静态清单，修饰键按平台显示），入口在网格工具栏右端与启动页右下角。
- 快捷键提示：`lib/keyHints.ts`（按状态选出最多三条，纯函数）、`views/common/KeyHints.tsx`（键名取自命令表，命令未注册的那条不显示）；显示在网格状态栏、单张信息条与对比视图底部提示条，设置 `showKeyHints` 可关。
- 后端事件可能先于命令应答到达前端，也可能有上一次打开的迟到事件：前端按 `generation` 丢弃过期事件，`openSession` 负责缓冲。
- 包管理器只用 npm；Tauri CLI 通过 `npm run tauri` 调用。

## 硬性约束

- **前端和协议地址里只出现 `FileId`，不出现文件路径。** 路径只在 Rust 侧由 `catalog::registry::Registry` 换算。例外只有实验面板的调试命令、系统交来的打开路径（`take_open_request`，原样传给 `open_path`），以及下列几处：仅用于显示的 `RootInfo.path` 和 `ImageDetails.path`，移动 / 复制的目标目录（来自系统对话框或最近目标，含 `OpReport.dest`），编辑“另存到其他位置”由系统保存对话框选出的目标路径（原样传给 `edit_save`，不持久化），对比面板“其他文件夹…”里由系统对话框选中的目录（原样传给 `browse_dir`，留在 `compareUi.otherDir`，不持久化），以及最近目录的路径（`RecentEntry.path`，只用于显示，并原样传回 `open_path` / `recents_pin` / `recents_remove`）。撤销失败只返回文件名，不返回路径。
- **不向前端开放通用文件系统权限。** 文件访问集中在 `catalog`、`fileops`、`thumbs` 和 `state`（`state` 只读写应用配置目录下自己的文件）；已有的例外是 `system.rs`（读图复制到剪贴板）与 `dragout.rs`（检查文件是否存在、读缩略图缓存后把路径交给系统拖拽），二者只按 `FileId` 读取，不写文件；不在别处直接碰磁盘（也是为将来上架 Mac App Store 的沙盒预留）。**解码器只接收内存字节，不自己打开文件**（`glance-syscodec`、`glance-imaging` 都是；读文件仍只发生在上述位置，读出来再交给 `decode.rs`）。
- **显示通道按内容而不是扩展名决定格式**：`protocol.rs` 读出字节后先 `heif::sniff`，命中就走后端解码，不信扩展名（改名成 `.png` 的 HEIC 照样能看）；没命中才按扩展名给 MIME。**`open_codec_help` 的参数只能是枚举 `CodecKind`（`heif` / `avif`），前端传不进任何网址**，商店地址写死在 `system.rs`；其中两个 Microsoft Store 产品编号凭记忆写的，**发布前必须在 Windows 上核对**。
- **内容安全策略禁止一切远程资源**；图片只允许 `glance:` 与 `http://glance.localhost`。只有 `devCsp` 为开发热更新放宽，正式 `csp` 不得放宽。
- **读文件和 CPU 密集任务不上主线程。** 已接受的例外：设置、最近目录、最近目标三份小配置文件在启动时（`setup` 里、窗口显示之前）读一次。
- **所有写文件的操作先写同目录临时文件，再原子改名。** 任何情况下不静默覆盖用户文件；改名、移动、复制只在 `fileops/fsx.rs` 里做（目标已存在即失败，不“先检查再改名”）。
- **项目自身以 GPL-3.0-only 发布**（根目录 `LICENSE`，四个 Cargo 包与 `package.json` 的许可字段一致）。**第三方依赖仍只用宽松许可**，以 `deny.toml` 的白名单为准（MIT、Apache-2.0、BSD、ISC、Zlib、IJG、MPL-2.0 等），不引入 GPL / LGPL / AGPL 的依赖：项目是 GPL 不等于依赖可以放宽，这样将来换许可或另行授权时不受依赖牵制。新增依赖时核对许可证；要加白名单以外的许可，先问用户。**不自带 HEVC / AV1 解码库**（HEIC / AVIF 一律用系统自带的解码能力：macOS 的 ImageIO，Windows 的 WIC，缺组件时引导安装）；V1.1-A 新增的依赖只有 `objc2-core-foundation`、`objc2-core-graphics`、`objc2-image-io`（仅 macOS）与 `windows`（仅 Windows）；另外 `glance-imaging` 在测试里用到了原已在依赖里的 `kamadak-exif`。
- **所有快捷键都登记在 `src/app/commands.ts` 的命令表里**，不要另外加零散的 keydown 监听（已有例外：框选与拖拽进行中的 Esc）。输入控件聚焦时只有标了 `allowInInput` 的命令响应。
- **界面文字一律走 `src/i18n/`**，不在组件里写死中文或英文；`zh-CN.ts` 与 `en.ts` 必须同步。实验面板除外。
- **单张视图用 `FileId` 记位置，不用下标**；解码好的图只来自预加载器，迟到的解码结果只有 id 和地址仍一致才显示。
- **画面用直接写进 DOM 的 transform 布局**，热路径上不走 React 状态。
- 窗口权限（capabilities）只为全屏增加了两项，另有 `dialog:allow-open` 与 `dialog:allow-save`（编辑另存）；没有拖拽权限（拖出由后端命令完成）。更新器在 Rust 侧，不占窗口权限。
- 唯一的网络请求是正式构建启动 3 秒后检查一次更新（设置里可关），失败静默。
- Rust 版本由 `rust-toolchain.toml` 固定为 1.95.0，两个工作流里 `dtolnay/rust-toolchain` 同版本；升级时三处一起改。
- 最低系统：macOS 12、Windows 10。macOS 上看 AVIF 要 macOS 13 及以上（系统 ImageIO 从 13 起才能解 AVIF）。
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
- 许可已选定为 GPL-3.0-only，版本号 1.0.0。
- 第一期（V0.1 到 V0.3）已于 2026-11-26 以 v1.0.0 发布。发布后的自动更新流程未验证。
- V1.1-A（HEIC / HEIF / AVIF 与编辑输出保留拍摄信息）：**macOS 代码完成、未目视确认；Windows 已在 CI 上编译并通过测试、真机未验证。不要写成“完成”。** 已做：三种新格式能列出、出缩略图、单张与对比里显示（经后端系统解码后以不压缩 PNG 返回）、复制到剪贴板、转格式 / 裁剪 / 去背景、批量转格式；缺系统解码组件时的占位、说明与“如何安装”；压缩 / 转格式 / 裁剪输出为 JPEG 或 WebP 时保留 EXIF（含位置）与 ICC，方向改写为已摆正，像素尺寸改成实际尺寸，预览与大小预估已计入；文件关联与注册表钩子加了三种扩展名。Rust 与 jsdom 测试覆盖，含在本机用系统编码器现编真 HEIC / AVIF 再解码的集成测试；不压缩 PNG 编码 4000×3000 由 140.5 ms 降到 22.7 ms（release，5 次中位数）；截断到 75% / 95% 的文件原先被系统解码器当成功，现由盒子完整性检查挡住。**没有试过任何真机拍的 iPhone / 安卓样张，没有在真实窗口里看过。** 实验 E1 到 E4（macOS）没做（`fixtures/heic/` 里没有样张，只有实验面板 HEIC 页与调试命令）；E5、E6（要 Windows 真机）没做；两个商店编号未核对。分支已于 2026-11-27 推送，CI 在 macOS 与 Windows 上全绿：WIC 解码（`windows.rs`）与 `open_codec_help` 的 Windows 分支能编译、冒烟测试通过，但 CI 机器上没有视频解码组件，真实的解码行为没跑过。CI 带来两处修改，都没有过独立审查：Windows 上“组件初始化失败”（`0x88982F8B`，CI 实测）也算缺少组件；macOS 26 的 CI 镜像上 Display P3 的 HEIC 在源色彩空间里画不上去（缓冲全 0），`macos.rs` 遇到这种情况退回 sRGB（广色域被换算），根因未查明，要在 macOS 26 真机上确认。清单见 `docs/后续事项.md` 的“V1.1-A 目视确认”与“V1.1-A 遗留小问题”。
- 第二期（V1.1，更多格式与照片）：四段需求已定。A 已按上条做到“macOS 代码完成、未确认”；B：SVG / TGA / TIFF / PSD 只读预览（设计与计划未写）；C：按拍摄时间排序与按天分组；D：粘贴剪贴板图片与拍摄位置。A 已建好“后端解码后再显示”的通道（`decode.rs` 与显示通道），B 直接用。进度表在 `docs/README.md`。
- 下一步：把真机拍的 HEIC / AVIF 样张（竖拍、人像、实况、P3、安卓 HEIF、带透明与 10 位的 AVIF）放进 `fixtures/heic/`，跑 `real_samples` 并做实验 E1 到 E4（macOS，E1 需要 macOS 12 机器）；在一台 macOS 26 真机上确认 P3 的 HEIC 能出图且颜色正常；在一台 Windows 机器上做 E5、E6 并核对两个商店编号；目视确认后才能说 V1.1-A 完成；之后再写 V1.1-B 到 V1.1-D 的设计与实施计划。
