# RFC-457 `services/` 的平台机制归 `platform`（RFC-294 W9-D 第四步）

- **状态**：In Progress（2026-11-06）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-456](../RFC-456-services-single-owner-placement/proposal.md)（单一 owner 的 14 个文件归位，`services/` 107 → 93）。
- **落位**：`platform/background`、`platform/persistence`（含 `sqlite/`）、`platform/workspace/local`、`platform/configuration`。

## 1. 背景

RFC-456 之后 `services/` 剩 93 个 TS 文件。其中 9 个（约 1.1K 行）是与业务无关的平台机制，只取 `util/`、`@agent-workflow/shared` 与
`platform/`，生产消费方都在 `platform/`、装配根与模块的 infrastructure / composition：

- 后台节奏与维护相位表（`daemonCadence`）、维护 ticker（`maintenanceTicker`）；
- 备份一族：SQLite 原始库快照（`rawDbSnapshot`）、备份 `VACUUM INTO` / `quick_check` 的 Worker 入口（`backupVacuumWorker`，发布二进制的
  额外入口）、可移植备份包（`portableBackupArchive`）、工作树备份的抓取与重建（`worktreeBackup`）；
- git 版本探测与能力缓存（`gitVersion`）、配置生效监听登记表（`configAppliedListeners`）；
- RFC-370 留下的进程启动器兼容入口（`execution/managedProcessLauncher`）：再导出 `platform/execution/local/managedProcessLauncher` 并带一个
  源码直跑入口。生产的源码直跑与内嵌 Windows 启动器都走 `platform/execution/local/managedProcessLauncherEntry.ts`，编译态走 `main.ts` 的
  隐藏子命令；这个文件只剩 `main.ts` 取三个导出与两个用例按路径直跑。

于是 `platform/` 反过来取 `services/`：8 个 platform 文件有 13 条这样的 import（另有 3 条取 `gitSubmodule` / `mergeAgent`，见 §3）。
架构报告的 legacy 归属表也早把其中 6 个记在 `platform` 名下。

## 2. 目标

- **G1 归位**：8 个文件迁入 `platform` 的对应子目录，函数体原样；`execution/managedProcessLauncher` 兼容入口删除，`main.ts` 直取
  `platform/execution/local/managedProcessLauncher`，按路径直跑启动器的用例改起生产的源码态入口 `managedProcessLauncherEntry.ts`。
- **G2 平台不取 legacy**：`platform/` → `services/` 的 import 16 → 3（余下 3 条见 §3）；不新增平台 → 模块的边（保持 0）、不新增目标 DAG
  之外的边、public surface、`module-layer-violations`、跨 context 内部文件对与不可达生产文件。
- **G3 行为不变**：只换位置与 import；备份 Worker 迁移后，二进制额外入口清单、编译态与源码态的 Worker 路径、架构门的二进制入口清单同步，
  发布二进制里 off-thread 备份不退回同线程。
- **G4 账本收口**：架构报告 legacy 归属表删去这 9 个文件；`commons-manifest` 的后台节奏登记改指新位置；Windows 平台 workflow 的路径
  过滤改指新位置。

## 3. 非目标

- `services/gitSubmodule.ts` 与 `services/mergeAgent.ts`：它们取 source-control 的 public 类型（`SubmoduleEntry`、合并冲突合同），属于
  source-control 一族（与 `commitPush` / `commitPushRunner` / `repoCredentials` 同批），`platform/workspace/local` 的隔离与 submodule 参数
  先要改经端口取，单独立 RFC。
- 运行时驱动一族、task-execution 独占的执行一族、余下 6 个一跳转出；安全相关改动。

## 4. 用户可见变化

无。发布二进制内备份 Worker 的内部路径随之改变，无外部影响。

## 5. 验收标准

- **AC-1**：9 个文件不在 `services/`，`src/`、用例与脚本零引用旧路径（含分段拼接的路径）；`platform/` 只余 3 条取 `services/` 的 import。
- **AC-2**：架构计数按实测：`services/` 93 → 84，`legacy-horizontal-files` 与 `legacy-service-implementations` 下降，`R1` / `R2` 不变，
  平台 → 模块 0、off-DAG 值边 0、值环 0、跨 context 内部文件对、off-DAG offered 文件对、public surface 偏差、`module-layer-violations`、
  不可达生产文件不升。
- **AC-3**：受影响用例（后台节奏与相位表、维护 ticker、原始库快照、备份 Worker 回退与 off-thread 校验、可移植备份与恢复、工作树备份、
  git 版本门、配置生效监听、进程启动器直跑与位置、入口根与顶层 await 守卫）全部通过；新增 RFC-457 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（含单二进制 build smoke；环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **`gitVersion`、`worktreeBackup`、`portableBackupArchive` 进 `platform`，不按归属表进 source-control / system-operations**：它们的
   消费方在 `platform/`（`workspace/local/submoduleParams`、`persistence/portableApplicationAssets`、`persistence/sqlite/systemProviderBackup`），
   进模块会让平台取模块（平台 → 模块必须为 0）；内容本身是 git 二进制探测、备份打包这类无业务语义的机制。
2. **备份 Worker 进 `platform/persistence/sqlite`**：与它包着的 `systemBackupVacuum`、起它的 `systemProviderBackup` 同目录；
   `platform/persistence/sqliteLogicalSourceWorker.ts` 已是平台里的二进制额外入口先例，编译态路径照它写。
3. **启动器兼容入口删除而不迁移**：它的再导出是对平台模块的恒等转发，直跑入口与生产的 `managedProcessLauncherEntry.ts` 做同一件事；
   保留一份等于留第二个启动器入口。
4. **`configAppliedListeners` 进 `platform/configuration`**：进程级登记表，装配根登记、system-operations 的配置 composition 与平台的维护
   服务通知，与 `platform/configuration` 的配置读取同类。
