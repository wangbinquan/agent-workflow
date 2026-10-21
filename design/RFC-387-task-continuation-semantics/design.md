# RFC-387 设计：任务续跑语义统一

研究基线 HEAD `9382675a0`（行号以实施时源码为准）。`T:` = `services/task.ts`，`B:` = `cli/daemonModules/taskExecution.ts`，
`A:` = `cli/daemonModules/adapters.ts`，`TE/` = `modules/task-execution/`，`S:` / `P:` / `V:` 为三个入口根，`T/` = `packages/backend/tests/`；
其余路径相对 `packages/backend/src/`。

## 1. 现状

| 路径 | SQLite | PostgreSQL |
| --- | --- | --- |
| 人工门唤醒 | S 的 worker（S:2394-2412）经 T:3266-3272 → `wakeHumanGateContinuation`（T:3131-3194）：旧协调器、`ensureWorkspaceProfiles: true`（T:3139）、进程级交接表（T:3124）、等 `awaitTaskDriverIdle` 后提交（T:3152-3193） | `createGateContinuationDriver({ isDriving, coordinator })`（`TE/application/drive/gateContinuationDriver.ts:12-24`，P:1841-1844）：本进程驱动中则跳过；worker 周期约 1 秒（`humanGateContinuationWorker.ts:34`、`:88-91`），决定事件也会提醒（`collaborationCommittedEventConsumers.ts:82-95`） |
| 房间续跑 | 适配器 A:159-170 → T:3241-3259（V:2068）：请求内用旧协调器驱动；提交后的错误抛给调用方（`workgroupTaskRoomCommands.ts:54-57`） | A:205-215：`assertResumable` = `composeWorktreeResumePreflight`，`driveAfterCommit` 为空操作；房间准入只发生命周期事件（`workgroupTaskRoomTaskParticipant.ts:303`、`:360`） |
| 仓库准备重试 | A:106-155 → T:4090 → T:3989-4076：原子准入（状态 CAS 到 pending + 意图，T:4007-4035）、旧协调器（T:4046） | `postgresqlRepositoryPreparationRetryCommand.ts:486-552`（`providerRuntime.ts:644-652` 接线）：请求内同步克隆（:505-519），进程内 `inFlight` 集合（:489-500），准入检查（:161-255）；启动自动续跑逐个等待（`services/autoResume.ts:142`） |
| 融合 | `fusionEngineTaskOperations.ts:44-111` → `startTask` → 旧协调器（T:2837-2869）：引擎失败被吞（T:1351）、上报器在无延后准备时提前返回（T:2846）、未挂上驱动时静默返回（T:2876-2887）；取消调用共享取消投影最多 8 次并吞错（:133-149） | `postgresqlFusionEngineTaskOperations.ts`：手工插行（:96-214），冻结原始定义（:133，未套内建布局，对照 T:2029-2030、`taskRouteLaunchOperations.ts:718-723`）；自建生命周期端口（:331-338）与协调器（:374-414）；失败不按世代终结全部意图（:390-413，`taskExecutionIntentTerminalSequence.ts:19-35`）；未挂上驱动时抛错（:420-425）；手写取消（:216-325） |
| 驱动释放收尾 | `finishClaimedWebhookWorkspacePrune`（`platform/persistence/sqlite/systemWorkspaceGc.ts:452-483`）：只清理 Webhook 终止、吞错 | `finalizeClaimedWorkspace`（`source-control/application/workspaceMaintenance.ts:552-557`）：抛错，且发生在 owner 行结算之后（`taskDriverRelease.ts:61-66`），会让等待结算的提交与提交内的提前释放路径失败（`taskDriveCoordinator.ts:115-175`、`:209-214`） |

## 2. 设计

### 2.1 门控续跑驱动（取舍 1）

模块组输出 `gateContinuation = createGateContinuationDriver({ isDriving: executionModule.runtimeRegistry.hasTask, coordinator: drives.session })`；
SQLite 与 PostgreSQL 的人工门 worker 都用它。删除 `wakeHumanGateContinuation` 的生产使用与进程级交接表；门控续跑的排除配置重建由 RFC-386
的意图类型规则负责。

### 2.2 房间续跑（取舍 2）

模块组输出一个中立的 `roomContinuation`：`assertResumable` = `composeWorktreeResumePreflight`；`driveAfterCommit` = 尽力调用 `gateContinuation`
（记录日志，提交之后绝不抛错）。删除两个适配器条目的 `roomContinuation`。

### 2.3 仓库准备重试（取舍 3）

`TE/infrastructure` 新增中立的 `createRepositoryPreparationRetryCommand`：PostgreSQL 的准入检查（:161-255）→ 原子准入（状态 CAS 到
`pending` + 续跑意图，取代 `inFlight`）→ `drives.session.submit({ completionMode: 'background' })`；会话协调器的延后准备步骤负责克隆并
生成下一次准备尝试（T:4195-4210）。删除 A:106-155、模块组的 `legacyLaunch` 输入与 `postgresqlRepositoryPreparationRetryCommand.ts` 的同步实现；
启动自动续跑改为只提交、不等待克隆。

### 2.4 融合适配器（取舍 4）

`TE/infrastructure` 新增中立的 `createFusionEngineTaskOperations`：启动内核式的冻结（套内建布局）与插行；`drives.session.submit`，
`completionMode` 来自调用方；失败经会话上报（按认领世代，`task drive failed` / `task-drive-failed`）；未挂上驱动时抛冲突错误；取消调用
provider 的 `cancellation` 一次（融合编排本身已重试 8 次，`fusionOrchestration.ts:960-978`）。两个 provider 运行时都改用它；删除 SQLite
版与 PostgreSQL 版适配器、模块组的 `fusion.startDeps`、`fusionRunConfiguration` 输入，以及失去唯一消费方的
`composeDaemonFusionModules.runConfiguration`（`cli/daemonModules/fusion.ts`）。

### 2.5 驱动释放收尾（取舍 5）

两个 provider 的释放收尾都用 `finalizeClaimedWorkspace`；`taskDriverRelease.ts` 在调用处捕获错误、记录日志并保留认领（维护的启动与定时
恢复会处理，`workspaceMaintenance.ts:495-516`）。SQLite 的 `nudgeWorkspacePrune` 改为 PostgreSQL 的形状；删除
`finishClaimedWebhookWorkspacePrune` 的生产使用与无调用方的 `finalizeCanceledTaskWithoutDriver`（T:428-433）。

### 2.6 删除 `createTaskDriveCoordinator`（取舍 6）

以上完成后它没有生产调用方：删除；`startTask`、`wakeHumanGateContinuation`、`resumeDynamicWorkflowExecution`、`retryRepositoryPreparation`
改为基于 RFC-386 工厂的仅测试包装（文件头注明 W4 删除），不改它们的测试调用方。

## 3. 测试策略

1. 门控续跑（双引擎，含 SQLite 旧接线对照）：评审 / 澄清决定后续跑由会话协调器驱动，带提炼观察者；引擎异常置任务失败。
2. 房间续跑（双引擎，含对照）：确认后立即驱动（PostgreSQL 旧接线不驱动）；提交后驱动失败不让确认请求失败（SQLite 旧接线会）。
3. 仓库准备重试（双引擎，含 PostgreSQL 对照）：请求立即返回、任务置回待执行；克隆失败异步记为任务失败并带 git 输出；并发重试被原子准入拒绝。
4. 融合（双引擎，含两边对照）：引擎失败置任务失败、只终结认领世代的意图；未挂上驱动时报冲突；冻结定义套内建布局；取消经会话取消。
5. 驱动释放收尾（双引擎）：收尾失败时提交照常结算，认领保留并被维护恢复处理。
6. 结构锁：后端无 `createTaskDriveCoordinator`；`new DefaultTaskDriveCoordinator(` 只在工厂内；适配器表不再有 `roomContinuation`。
7. 旧锁（改指，不放宽）：`T/rfc319-cfg45-default-runtime-hot-read.test.ts`、`T/rfc370-task-launch-configuration*.test.ts`、`T/rfc287-t13-deferred-prep.test.ts:988-1087`、
   `T/rfc165-*.test.ts`、`T/rfc341-collaboration-source-locks.test.ts:169-200`、`T/rfc370-workspace-resume-presence.test.ts:196`、
   `T/rfc349-repository-preparation-postgresql-adapter.test.ts`、`T/repo-prep-retry-secretbox.test.ts`、`T/architecture/rfc294-review-offered-edge-dag.test.ts`（融合
   适配器的边）、`T/architecture/rfc359-w7-task-insert-lineage-completeness.test.ts:61-88`、`T/rfc370-workspace-maintenance-effects.test.ts:386`（命令仍抛错）；
   账本：`architecture/commons-debt.json`（`services/task.ts` → `TE/composition/{taskDriveLegacy,gateContinuationPreDrive}` 等）、`architecture/guard-manifest.json`；
   `architecture/counts.json` 不升。

## 4. 与 RFC-294 目标架构的对齐

续跑、重试与融合都经会话驱动设施，task-execution 应用层成为唯一的驱动协调来源；达成 RFC-294 本区域的出口判据（`createTaskDriveCoordinator`
无生产调用方）。留下的债：两个 provider 运行时函数（RFC-388）；仅测试的旧入口（W4）。无偏离项。
