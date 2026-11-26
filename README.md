<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Glance"><br>
  <b>Glance</b> · 打开一个文件夹，一口气看完里面所有图片<br>
  <a href="#怎么用">怎么用</a> •
  <a href="#快捷键">快捷键</a> •
  <a href="#常见问题">常见问题</a> •
  <a href="#从源码构建">从源码构建</a>
</p>

<p align="center">
  <a href="https://github.com/huxiaohei/Glance/actions/workflows/ci.yml"><img src="https://github.com/huxiaohei/Glance/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/平台-macOS%20%7C%20Windows-blue" alt="平台">
  <img src="https://img.shields.io/badge/价格-免费-brightgreen" alt="免费">
</p>

> [!NOTE]
> Glance 还在开发中，尚未发布安装包。功能做完后会在 [Releases](https://github.com/huxiaohei/Glance/releases) 发布 macOS 与 Windows 版本。

## 为什么做 Glance

整理照片、挑设计稿、翻素材库、核对截图时，你要的是“把这个文件夹里的图都过一遍”，而系统自带的看图工具是按“一张图”设计的：

- **双击一张、关掉、再开下一张。** 子目录里的图更麻烦，得一层层点进去。
- **一大堆图第一次打开很慢**，缩略图要等，大图切换要转圈。
- **看到不要的图想顺手删掉、改名、挪个地方**，得切回访达或资源管理器，回来又找不到看到哪了。

Glance 把“文件夹”当成看图的单位：打开一次，里面（包括子目录）所有图片按目录分组排好，网格里扫一眼，回车放大，左右键翻页，看到哪处理到哪。

## 怎么用

**1. 打开一个文件夹**

任选一种：

- 启动页点“打开目录”，或按 <kbd>⌘O</kbd> / <kbd>Ctrl+O</kbd>
- 把文件夹或图片拖进窗口、拖到 Dock 图标上
- 在访达里右键文件夹 →“服务 → 用 Glance 打开”；图片右键 →“打开方式 → Glance”（Windows 在“打开方式”里）
- 启动页的“最近目录”一点就回到上次的位置，常用的可以固定

拖进来的是一张图片时，Glance 会打开它所在的文件夹并直接显示这张图。Glance 已经开着时再打开别的，会在原窗口里接手，不会多开。

**2. 在网格里扫一遍**

所有图片按子目录分组显示成缩略图。左侧目录树可以跳到某个子目录，按 <kbd>Tab</kbd> 收起；顶部可以按文件名、修改时间、文件大小排序，也可以选择是否包含子目录。文件夹里新增、删除、改名的图会自动跟上，不用刷新。

**3. 放大看、连续翻**

双击或回车进入单张视图。左右方向键翻页，相邻的图已经提前解码好，切换几乎没有等待。滚轮以鼠标位置为中心缩放（也可以在设置里改成滚轮翻页），放大后拖动平移，<kbd>0</kbd> 适应窗口，<kbd>1</kbd> 原始大小，<kbd>F</kbd> 全屏，<kbd>I</kbd> 看拍摄参数等 EXIF 信息，<kbd>Esc</kbd> 返回上一级（从网格进来的回到网格并停在刚才那张，从对比进来的回到对比）。

**4. 看到哪，处理到哪**

在网格或单张视图里都能直接操作，选中一张或多张（⌘/Ctrl 单击、Shift 单击、鼠标框选）后：

- **删除**：移到废纸篓 / 回收站
- **重命名**：<kbd>F2</kbd>
- **移动、复制**：右键选目标文件夹，可以当场新建子目录；或者直接把缩略图拖到左侧目录树上（按住 <kbd>⌥</kbd> / <kbd>Ctrl</kbd> 是复制）
- **交给别的应用**：把缩略图拖出窗口，拖到聊天软件、邮件或 Photoshop 里
- **复制图片 / 路径**：<kbd>⌘C</kbd> / <kbd>⌘⇧C</kbd>

手滑了按 <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd> 撤销。目标位置有同名文件时会先跳过，提示条上可以一键“保留两者”，不会悄悄覆盖文件。

**5. 挑几张放在一起比**

在网格或单张视图里按 <kbd>空格</kbd> 把当前图（或选中的几张）加入对比，再按一次移出；按 <kbd>C</kbd> 进入对比视图，几张图并排显示。<kbd>Ctrl/⌘</kbd> + 滚轮同步缩放所有格子，放大后拖动平移，<kbd>S</kbd> 开关同步；<kbd>Delete</kbd> 把当前格移出对比（不会删除文件）；双击某一格放大单看，<kbd>Esc</kbd> 回来。拖动格子可以调整顺序（放大后的格子拖动是平移，不排序），或用 <kbd>Alt</kbd> + 方向键与相邻的图交换位置。按 <kbd>Tab</kbd> 打开右侧的添加面板，从当前文件夹、子文件夹或其他文件夹里点选图片加入或移出，<kbd>Esc</kbd> 回到图片区。换文件夹后对比篮仍然保留，重启后也会恢复（文件已被移走的会显示为占位）。

**6. 压缩、裁剪、去背景、转格式**

在单张视图按 <kbd>E</kbd> 进入编辑，右侧滑出面板：“压缩”页拖质量滑块，可选限制最长边，PNG 可选有损（体积更小，画质略降，半透明边缘会有轻微变化）或无损；“转格式”页转成 JPEG、PNG 或 WebP（透明部分可选白、黑或自定义底色）。拖动时画面实时预览，面板底部显示预估大小与节省比例，按住“看原图”按钮对比原图。<kbd>Enter</kbd> 保存（默认另存副本，文件名带 `_compressed` / `_converted`，重名自动加序号；也可在保存按钮的下拉里选“覆盖原图”或“另存到其他位置…”；设置里可以把默认改成覆盖原图），<kbd>Esc</kbd> 取消。默认是另存副本时，从下拉里选“覆盖原图”会先确认一次。覆盖时原图先进废纸篓，之后仍可 <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd> 撤销。动图暂不支持编辑。保存成 JPEG 或 PNG 时图片自带的色彩配置（ICC）会保留，压缩 WebP 或转成 WebP 后会丢失。

**裁剪**：“裁剪”页在图上拖出裁剪框，四边四角共 8 个控制点可调整，拖框内部移动位置；比例有“自由 / 1:1 / 4:3 / 16:9 / 自定义”（竖图可一键横竖互换），自由模式下按住 <kbd>Shift</kbd> 拖角可锁定当前比例；也可直接输入宽、高像素。支持左右旋转 90°、水平 / 垂直翻转，“还原”回到整张图。裁剪页不能缩放画面，缩放键、滚轮和双击都不起作用。输出保持原格式（JPEG、WebP 质量 95，PNG 无损，GIF、BMP 存成 PNG），尚未改动时保存按钮不可用；另存副本的文件名带 `_cropped`。

**去背景**：“去背景”页有两种方式。“透明度阈值”（0–255，可选去掉低于或高于阈值的像素）只适用于本身带透明像素的图。“按颜色”：点一下图片取背景色（默认取左上角像素），拖“容差”决定相近多少算背景，“边缘柔化”让边缘过渡更自然，同时去掉渗进边缘的背景色；“只去掉与边缘连通的区域”默认开启，不会误伤主体内部的同色部分。被去掉的区域以棋盘格显示。输出一律是 PNG，另存副本的文件名带 `_nobg`；对非 PNG 图覆盖原图时，原图会被换成同名的 `.png`，仍可撤销。

## 快捷键

macOS 下 Mod 是 <kbd>⌘</kbd>，Windows 下是 <kbd>Ctrl</kbd>。应用里按 <kbd>?</kbd> 可以随时看到完整列表。

| 场景 | 按键 | 作用 |
|------|------|------|
| 通用 | <kbd>Mod+O</kbd> | 打开文件夹 |
| | <kbd>F5</kbd> / <kbd>Mod+R</kbd> | 重新扫描 |
| | <kbd>Tab</kbd> | 显示 / 隐藏目录树 |
| | <kbd>F</kbd> | 全屏 |
| | <kbd>Mod+,</kbd> | 设置 |
| | <kbd>?</kbd> | 快捷键一览 |
| 网格 | 方向键（加 <kbd>Shift</kbd> 扩选） | 移动选中 |
| | <kbd>Mod+A</kbd> / <kbd>Esc</kbd> | 全选 / 取消选择 |
| | <kbd>Enter</kbd> | 放大查看 |
| 单张 | <kbd>←</kbd> <kbd>→</kbd>，<kbd>Home</kbd> <kbd>End</kbd> | 上一张、下一张，第一张、最后一张 |
| | <kbd>+</kbd> <kbd>-</kbd>，<kbd>0</kbd>，<kbd>1</kbd> | 放大缩小，适应窗口，原始大小 |
| | <kbd>I</kbd> | 详情面板 |
| | <kbd>Esc</kbd> | 返回上一级（网格或对比） |
| 对比 | <kbd>空格</kbd> | 加入 / 移出对比（网格、单张） |
| | <kbd>C</kbd> | 进入对比 |
| | <kbd>S</kbd> | 同步缩放开关（对比中） |
| | <kbd>Tab</kbd> | 打开 / 收起添加面板（对比中） |
| | <kbd>Alt</kbd> + 方向键 | 与相邻的图交换位置（对比中） |
| 编辑 | <kbd>E</kbd> | 进入编辑（单张）：压缩、转格式 |
| | <kbd>Enter</kbd> | 保存（编辑中） |
| | <kbd>Esc</kbd> | 取消编辑 |
| 文件 | <kbd>⌘⌫</kbd>（macOS）/ <kbd>Delete</kbd>（Windows） | 移到废纸篓 |
| | <kbd>F2</kbd> | 重命名 |
| | <kbd>Mod+C</kbd> / <kbd>Mod+Shift+C</kbd> | 复制图片 / 复制路径 |
| | <kbd>Mod+Z</kbd> | 撤销上一步 |

## 常见问题

**支持哪些格式？** 目前是 JPEG、PNG、WebP、GIF、BMP。

**图片会上传吗？** 不会，图片只在本机读取和处理。唯一的网络请求是启动 3 秒后检查一次有没有新版本，可以在设置里关掉。

**会改动我的文件吗？** 只有你主动删除、改名、移动、复制时才会。删除是移到废纸篓，所有操作都能用 <kbd>Mod+Z</kbd> 撤销；遇到同名文件不会覆盖。

**收费吗？** 免费。如果它帮到了你，可以点启动页右下角探头的小老虎请作者喝杯奶茶。

**macOS 提示“无法验证开发者”？** 目前没有付费签名。到“系统设置 → 隐私与安全性”，点“仍要打开”。

**Windows 弹出 SmartScreen 警告？** 点“更多信息 → 仍要运行”。

**接下来会加什么？** 裁剪、去背景等轻量编辑。

## 从源码构建

需要 Rust 1.95.0（`rust-toolchain.toml` 会自动选用）、Node.js 26 与 npm；macOS 12+ 装 Xcode Command Line Tools，Windows 10+ 装 Visual Studio 生成工具（MSVC）与 WebView2。

```sh
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包
```

macOS 的应用在 `target/release/bundle/macos/Glance.app`，Windows 的安装程序在 `target/release/bundle/nsis/`。

提交前需要通过的检查：

```sh
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm test
npx tsc --noEmit
```

代码结构：`src/` 是前端（React + TypeScript），`src-tauri/` 是应用壳与后端（Rust），`crates/glance-imaging/` 是不依赖 Tauri 的图片解码与缩略图库。第三方依赖只用宽松许可，由 `cargo deny` 在 CI 里检查。
