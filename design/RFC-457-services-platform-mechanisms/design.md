# RFC-457 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`P/` = `S/platform/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 只剩到期删除的一跳 facade——实现文件按 owner 归位。RFC-454～456 做了一跳转出、资源包一族与单一
  owner 的零散实现；本 RFC 做「与业务无关、只被平台 / 装配根 / 模块 infrastructure 与 composition 使用」的平台机制。
- 平台是最底层：模块、装配根取平台都是允许的边；平台不得取模块（`platform-to-modules-file-pairs` 保持 0），也不该取 legacy 横向层。
  本 RFC 后平台取 `services/` 只余 source-control 一族的 3 条。
- 不新增 public 导出；不新增目标 DAG 之外的边。

## 1. 文件去向

| 原位置                                  | 新位置                                       | 说明                                                                                 |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `L/daemonCadence.ts`                    | `P/background/daemonCadence.ts`              | 后台节奏与维护相位表（纯常量）                                                       |
| `L/maintenanceTicker.ts`                | `P/background/maintenanceTicker.ts`          | 维护 ticker（可注入计时器、慢节拍）                                                  |
| `L/rawDbSnapshot.ts`                    | `P/persistence/sqlite/rawDbSnapshot.ts`      | SQLite 原始库快照（`rawCopyDb`，取同目录的快照机制与备份清单）                       |
| `L/backupVacuumWorker.ts`               | `P/persistence/sqlite/backupVacuumWorker.ts` | 备份 `VACUUM INTO` / `quick_check` 的 Worker 入口（二进制额外入口）                  |
| `L/portableBackupArchive.ts`            | `P/persistence/portableBackupArchive.ts`     | 可移植备份包（取 `content/locations` 与 SQLite 备份清单）                            |
| `L/worktreeBackup.ts`                   | `P/persistence/worktreeBackup.ts`            | 工作树备份的抓取与重建（`portableApplicationAssets` 唯一使用）                       |
| `L/gitVersion.ts`                       | `P/workspace/local/gitVersion.ts`            | git 版本探测与能力缓存（解析在 `P/contracts/gitVersion.ts`，本文件再导出）           |
| `L/configAppliedListeners.ts`           | `P/configuration/configAppliedListeners.ts`  | 配置生效监听登记表（进程级）                                                         |
| `L/execution/managedProcessLauncher.ts` | 删除                                         | 兼容再导出 + 源码直跑入口；生产走 `P/execution/local/managedProcessLauncherEntry.ts` |

`services/execution/` 余 12 个文件，不变空；`services/` 下没有目录变空。

## 2. 消费方改指

- **platform 内**（8 个文件）：`background/{maintenanceCatalog,maintenanceSchedule,providerBackupScheduler}` 取 `./daemonCadence`；
  `background/{maintenanceService,providerBackupScheduler}` 取 `./maintenanceTicker`；`background/maintenanceService` 取
  `@/platform/configuration/configAppliedListeners`；`background/providerBackupScheduler` 与 `persistence/sqlite/systemProviderRestore` 取
  `rawDbSnapshot`；`persistence/portableApplicationAssets` 取 `./worktreeBackup`、`./portableBackupArchive`；
  `persistence/sqlite/systemProviderBackup` 取 `../portableBackupArchive` 并改 Worker 路径（§3）；`workspace/local/submoduleParams` 取
  `./gitVersion`。
- **装配根**：`bootstrap/daemonSession.ts`（节奏表、配置生效监听）、`bootstrap/epochMigrationAuto.ts`（ticker）、`bootstrap/standalone.ts`
  （git 版本探测）改取新位置；`main.ts` 的启动器三个导出改取 `./platform/execution/local/managedProcessLauncher`。
- **模块**（都在 infrastructure / composition，`R2` 不变）：source-control `infrastructure/local/repositoryBatchImport.ts`（节奏表、ticker）、
  task-execution `composition/providerBackground.ts`（节奏表）、system-operations `composition.ts` 与 `composition/applicationConfiguration.ts`
  （配置生效监听）、system-operations `infrastructure/{postgresqlProviderBackup,crewstation/databaseBackups,crewstation/databaseBackupArtifact}.ts`
  （可移植备份包）。
- 迁移的文件之间：`maintenanceTicker` 取 `./daemonCadence`。

## 3. 二进制入口与 CI 路径

- `scripts/build-binary.ts` 的 `WORKER_ENTRIES`：`join(backendSrc, 'services', 'backupVacuumWorker.ts')` 改为
  `join(backendSrc, 'platform', 'persistence', 'sqlite', 'backupVacuumWorker.ts')`。
- `P/persistence/sqlite/systemProviderBackup.ts` 的 `BACKUP_VACUUM_WORKER_ENTRY`：编译态 `'./services/backupVacuumWorker.ts'` 改为
  `'./platform/persistence/sqlite/backupVacuumWorker.ts'`（`$bunfs` 里按入口共同根 `S/` 的相对路径，与 `sqliteLogicalSourceWorker` 同式），
  源码态 `new URL('../../../services/backupVacuumWorker.ts', import.meta.url)` 改为 `new URL('./backupVacuumWorker.ts', import.meta.url)`。
- 架构门 `T/architecture/rfc294Gates.ts` 的 `BINARY_ENTRIES` 改指新位置（可达性与顶层 await 守卫以它为根）。
- `.github/workflows/windows-platform.yml` 的路径过滤：`services/gitVersion.ts` 改为 `platform/workspace/local/gitVersion.ts`（两处）；
  `services/execution/managedProcessLauncher.ts` 删除（两处；`platform/execution/local/**` 已覆盖启动器本体与入口）。
- `T/architecture/rfc427-entry-root.test.ts` 的 `main.ts` 入口白名单：`./services/execution/managedProcessLauncher` 改为
  `./platform/execution/local/managedProcessLauncher`（理由不变：启动器先于任何装配运行）；`rfc400` 顶层 await 守卫的说明同步（`main.ts`
  不再取任何带顶层 await 的模块）。

## 4. 用例

- **新用例** `T/rfc457-services-platform-mechanisms.test.ts`：9 个旧文件不存在、8 个新位置都在；`S/`、用例与 `scripts/` 零引用旧路径（census
  AST 认别名与相对路径，带负对照）；8 个新文件只取 `util/`、shared、node 与 `platform/`（不取 `modules/`、`services/`）；`platform/`
  取 `services/` 的边恰好是 source-control 一族的 3 条（带负对照）；`WORKER_ENTRIES`、`BINARY_ENTRIES` 与
  `BACKUP_VACUUM_WORKER_ENTRY` 三处指向同一个存在的文件，编译态路径是它相对 `S/` 的路径、源码态 URL 相对 `systemProviderBackup.ts`
  解析到它（带负对照）；`main.ts` 直取平台的启动器模块。分段拼接与只提文件名的读法由实施时按 `docs/dev-gotchas.md` 的三种形态
  全仓搜、`test-suite-policy` 的模块作用域读路径检查兜底。
- **随迁的锁**：按路径读源码的锁改指新位置（`rfc311` / `rfc349` 备份 Worker、`rfc349-provider-cutover` 边清单、`rfc208` git 版本超时、
  `rfc322` ticker 豁免、`rfc376` setInterval 站点、`rfc328` / `rfc370` 启动器直跑路径改起
  `managedProcessLauncherEntry.ts`）；架构报告 legacy 归属表删去 9 条；`commons-manifest.json` 后台节奏条目的 `files` 改指新位置；
  guard-manifest 刷新行数。迁移前按 `docs/dev-gotchas.md`「移动/重命名源文件后至少扫这三种形态」全仓搜（字面量路径、分段拼接、只提文件名）。
- **不动的**：拿旧路径当合成探针的负样本（`rfc377` util/git 叶子锁、`rfc418` 应用层取 legacy 的判据）——它们断言判据、不读文件；
  描述历史的清单（`rfc317-lifecycle-status-sets` 与 `shared/src/lifecycle.ts` 里「此前六份手抄数组」的出处）；冻结的 epoch-1 协议
  副本 `T/helpers/epoch1Protocol/sqliteClient.ts`。
- **账本**：`R1` / `R2` 预期不变（9 个文件都不取模块；模块侧消费方都在 infrastructure / composition）。
- **文档**：`docs/env-flags.md`（启动器）与 `docs/audit-backlog.md`、`docs/dev-gotchas.md` 里描述现状的路径改指新位置，带日期的历史记录不动；
  `commons-debt.json` 的 TP-12 登记锚点是带日期的审计记录，不动。

## 5. 留下的债

- `platform/workspace/local/{isolation,submoduleParams}.ts` 取 `services/gitSubmodule.ts` 与 `services/mergeAgent.ts`（3 条）：两者取
  source-control 的 public 类型，随 source-control 一族归位时由平台改经端口取。
- 架构报告归属表里 `gitVersion` / `worktreeBackup` / `portableBackupArchive` 原记 source-control / system-operations，本 RFC 按消费方
  归 `platform`（见 proposal §6）。

## 6. 失败模式

- 漏改的消费方：tsc 兜底（旧文件删除后取不到）；按路径读源码的锁经新用例的零引用断言与 `test-suite-policy` 的「模块作用域读的源码路径
  都在」兜底。
- 发布二进制里 Worker 找不到（RFC-311 实现门 P0-1 的形态）：三处路径由新用例锁成同一个文件；CI 的单二进制 build smoke 跑编译态。
- 进程级登记表出现第二份：旧文件删除后全仓只剩一条 import 路径（新用例的零引用断言）。

## 7. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §4；P0 变异 lane 两引擎各 17 阶段；推送后看 build smoke。
