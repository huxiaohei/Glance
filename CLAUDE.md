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
cargo run --release -p gen-fixtures -- <preset> --out fixtures/<preset>   # 生成样张：transport | huge | many
cargo test -p glance --test trash_roundtrip -- --ignored                  # 废纸篓测试（会动真实废纸篓）
```

每次改动结束前，前四条检查必须全部通过。

## 工程结构

- Cargo 工作区：`src-tauri`（包名 `glance`，库名 `glance_lib`）、`crates/glance-imaging`（纯图片库，不依赖 Tauri）、`tools/gen-fixtures`。
- 前端在 `src/`：`lib/` 放纯函数，`lab/` 是实验面板，`i18n/` 是界面文字。
- 包管理器只用 npm；Tauri CLI 通过 `npm run tauri` 调用。

## 硬性约束

- **前端和协议地址里只出现 `FileId`，不出现文件路径。** 路径只在 Rust 侧由 `catalog::registry::Registry` 换算。唯一例外是实验面板的调试命令。
- **不向前端开放通用文件系统权限。** 文件访问集中在 `catalog` 和 `fileops`，不在别处直接碰磁盘（也是为将来上架 Mac App Store 的沙盒预留）。
- **内容安全策略禁止一切远程资源**；图片只允许 `glance:` 与 `http://glance.localhost`。只有 `devCsp` 为开发热更新放宽，正式 `csp` 不得放宽。
- **读文件和 CPU 密集任务不上主线程。**
- **所有写文件的操作先写同目录临时文件，再原子改名。** 任何情况下不静默覆盖用户文件。
- **第三方依赖只用宽松许可**（MIT、Apache-2.0、BSD、ISC、Zlib、IJG 等），不引入 GPL / LGPL / AGPL。新增依赖时核对许可证。
- **界面文字一律走 `src/i18n/`**，不在组件里写死中文或英文；`zh-CN.ts` 与 `en.ts` 必须同步。实验面板除外。
- 最低系统：macOS 12、Windows 10。
- 依赖版本锁在 `Cargo.lock` 和 `package-lock.json` 里并提交。

## 开发方式

- 先写失败的测试，再写实现。
- 实验面板（`src/lab/`、`src-tauri/src/lab.rs`）只在调试构建里编译和注册，正式功能不得依赖它。
- 废纸篓测试只能操作测试自己在临时目录里创建的文件，不得清空废纸篓或动其他文件。
- 无法目视确认的界面行为（窗口显示、拖拽、实验读数）要明确说明“未验证”，并给出人工检查步骤，不要写成已通过。

## 当前进度

M0 的任务 1 到 6 已完成（工程骨架、样张生成器、文件登记与协议、废纸篓、拖拽实验页、编码器）。启动页的“打开目录”和拖入目录尚未实现，属于 V0.1。
