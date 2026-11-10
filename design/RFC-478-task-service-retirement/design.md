# RFC-478 技术设计

**承担的演进**：W9-D 的 task-execution 一族收尾——`services/task.ts` 退役，`R1` 少 9 条；按 RFC-294 C10 按内容分层落位；延后仓库准备
对 source-control 只经 consumer 自有端口；测试专用出口离开生产树；失去模块外消费方的 public 符号撤出（含 S9 第 1 项点名的两个写原子）。
**留下的债**：`infrastructure/taskRouteLaunchOperations.ts` 归 application（design §5.6，另立）；`public/operations` 余下的写原子（S9）；
`taskExecutionModule` 的 import 期构造（S12）。

## 1. 落位总表

| 原内容（`services/task.ts`）                                                                                                                               | 新位置                                                                                         | 层                    | 理由（C10 / 常驻规则 10）                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `layoutBuiltinWorkflowSnapshot`、`projectWorkflowSnapshotForRead`、`layoutBuiltinWorkflowSnapshotJson`                                                     | `domain/builtinWorkflowLayout.ts`                                                              | domain                | 纯函数，只取 shared 的 schema 与布局规划器                                                              |
| `buildSyncRunSummary`、`parseSnapshotDefinition`、`WRAPPER_BREADCRUMB_TERMINAL`                                                                            | `domain/workflowSyncPreview.ts`（既有，已有门因与内置预览）                                    | domain                | 纯函数，与同步预览的既有 domain 判据同处                                                                |
| `computeWorkflowSyncPreview`、`WorkflowSyncPreviewValidation`、闭包冻结两个私有函数                                                                        | `application/workflowSyncPreviewQuery.ts`                                                      | application           | 路由操作调用的查询用例；读取经端口                                                                      |
| 预览的四个读                                                                                                                                               | `application/ports/workflowSyncPreviewReads.ts` + `infrastructure/workflowSyncPreviewReads.ts` | port / infrastructure | consumer 自有端口，实现取既有查询工厂                                                                   |
| `selectSyncRollbackTargets`                                                                                                                                | `application/resumeRollbackTargets.ts`（既有）                                                 | application           | 与兄弟 `selectResumeRollbackTargets` 同处，取 `application/runHistory`                                  |
| 延后仓库准备：描述读取、准备执行、`runDeferredRepoPreparation`、`prepareLegacyDeferredWorkspace`、`reclaimStalePrepArtifacts`、`taskRepoRowsFor`、依赖类型 | `infrastructure/deferredRepositoryPreparation.ts`                                              | infrastructure        | RFC-328 effect 现场 + 持久化写入协议 + fs / git（RFC-475 经验：带 effect 观察者的现场不进 application） |
| `composeDeferredRepositoryPreparationStep`                                                                                                                 | `composition/deferredRepositoryPreparation.ts`（既有）                                         | composition           | 装配：`new PersistedRepositoryPreparationStep(reader, preparer)`                                        |
| `getTask`、`loadTaskFailureCodes`                                                                                                                          | `infrastructure/taskDetailRead.ts`                                                             | infrastructure        | 读侧查询投影                                                                                            |
| `runtimeConfigOpts`                                                                                                                                        | `composition/taskDriveRuntimeOptions.ts`                                                       | composition           | 配置 → 驱动选项的装配漏斗，bootstrap 取                                                                 |
| `isTaskActive`、`abortAllActiveTasks`                                                                                                                      | `tests/helpers/taskDriverRegistry.ts`                                                          | 用例 helper           | 生产零调用方                                                                                            |
| `TaskContinuationDependencies`                                                                                                                             | `tests/helpers/taskContinuationDependencies.ts`                                                | 用例 helper           | 生产只经两处 `Pick` 取字段，改写成显式类型                                                              |
| `shutdownActiveTaskExecutions`                                                                                                                             | 删除                                                                                           | —                     | 零调用方（只在一条「不得包含」的源码锁里出现）                                                          |

函数体逐字迁移；差异只有 import 改取本模块定义处（不经自己的 `public/*`）、下面 §2 的端口化与 §5 的依赖类型显式化。

## 2. 延后仓库准备

### 2.1 依赖

`DeferredRepositoryPreparationDependencies` 改为显式字段（不再 `Pick` 测试依赖袋）：`db`、`repositoryPreparation`（**必填**）、
`repositoryPreparationLookup`、`loadFrozenSpaceLayout`、`secretBox?`、`cloneTimeoutMs?`、`gitBaselineSyncWindowMs?`、`launchConfiguration?`、
`workspaceCleanupHook?`、`gitCommitIdentity?`。`repositoryWorkspace` 删除。

### 2.2 source-control 只经绑定

原文件取 source-control `composition` 的四个值（另取 public 的 `resolveRepoGroupLayout`）；迁移后：

| 原调用                                                                                                                              | 迁移后                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMaterializedSpaceCleanup(taskId, null)`                                                                                      | 在 infrastructure 里按 task 自有的 `MaterializedSpaceCleanup` 端口类型构造同一个空账本（`{ taskId, ownedRoot: null, worktrees: [], state: 'owned', report: null }`）                                                                                          |
| `materializeSpaceWithProvider(...)`（无绑定时）                                                                                     | 删除：绑定必填后只剩 `binding.legacy.prepare(...)` 一条                                                                                                                                                                                                       |
| `cleanupMaterializedSpaceLease(prepared.cleanup, hook)`（离开窗口、非日志化准备）                                                   | `binding.legacy.cleanup(prepared, hook)`：即 `cleanupMaterializedSpaceLease(space.cleanup, hook ?? 绑定的钩子)` 加一次 `materializingSpaces.delete(taskId)`；后者只登记 scratch 空间，延后准备的来源只有缓存仓 / 仓库组，为空操作；生产上步骤与绑定都不传钩子 |
| `resolveRepoGroupLayout(composeSqliteRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db)), groupId)`（重试回收的组成员） | `binding.groupCachedRepoIds(groupId)`：绑定里与 `groupName` 同源（同一个 `resolveRepoGroupLayout`，同一个 `composeRepositoryWorkspaceStore(db, taskPorts)`；`composeSqliteRepositoryWorkspaceStore` 本就是它的别名），回收侧照旧 `try` 住、只收非空 id        |

于是 task-execution 的新 infrastructure 文件不取 source-control 的 `composition` 或内部；类型改取 task 自有的
`application/ports/preparedWorkspace.ts`。

### 2.3 读取与执行端口

`infrastructure/deferredRepositoryPreparation.ts` 导出 `createDeferredRepositoryPreparationReader(deps)`（`RepositoryPreparationDescriptorReader`）
与 `createDeferredRepositoryPreparer(deps, appHome)`（准备执行）；`composition/deferredRepositoryPreparation.ts` 的
`composeDeferredRepositoryPreparationStep` 用它们 `new PersistedRepositoryPreparationStep(reader, preparer)`。读取、围栏、残骸回收、
`runDeferredRepoPreparation` 的窗口重试、三种收场与回填事务逐字不变。

## 3. 工作流同步预览

`application/ports/workflowSyncPreviewReads.ts`：

```ts
export interface WorkflowSyncPreviewReads {
  listNodeRuns(taskId: string): Promise<readonly NodeRunFactSnapshot[]>
  freshestDoneTopLevelRunId(taskId: string, nodeId: string): Promise<string | null>
  producedPorts(
    nodeRunIds: readonly string[],
  ): Promise<readonly { nodeRunId: string; portName: string }[]>
  frozenTriggerContext(taskId: string): Promise<string | null>
}
```

实现 `infrastructure/workflowSyncPreviewReads.ts` 的 `createWorkflowSyncPreviewReads(db)` 分别取 `createNodeRunQueries(db).list`、
`createRunSelectionReader(db).familyHistory(…, { topLevelOnly: true, statusIn: ['done'] }).at(-1)`、`createNodeOutputQueries(db).listProducedPorts`、
`createTaskTriggerQueries(db).frozenContext`——与原函数体里的四处调用一一对应。`computeWorkflowSyncPreview(reads, task, workflow,
resourceAuthority, validateHostWorkflow)` 的其余步骤（内置工作流短路、闭包冻结、差异、静态校验、触发预检、门因）逐字不变；
`taskRouteOperations` 传 `createWorkflowSyncPreviewReads(db)`。

## 4. 任务详情读投影

`getTask(db, id)` 与 `loadTaskFailureCodes(db, rows)` 原样进 `infrastructure/taskDetailRead.ts`（快照投影取 domain 的
`projectWorkflowSnapshotForRead`，批量选择取 `application/runHistory` 的 `createRunHistoryBatchSnapshot`）。消费方：
`composition/digitalEmployeeExecution.ts`、`infrastructure/taskRouteOperations.ts`、`infrastructure/taskListPage/database.ts` 与延后准备。

## 5. 运行时选项与测试专用出口

- `composition/taskDriveRuntimeOptions.ts`：`runtimeConfigOpts(deps)` 与它的入参类型 `TaskDriveRuntimeConfiguration`（原 `Pick` 的 17 个字段
  逐个写出，类型取各自定义处），返回 `Partial<TaskDriveRuntimeOptions>`；bootstrap 的 `daemonModules/taskExecution.ts` 改取这里。
- `tests/helpers/taskDriverRegistry.ts`：`isTaskActive`（`infrastructure/taskDriverLifecycle` 的 `isTaskDriverActive`）、`abortAllActiveTasks`
  （`taskExecutionModule.runtimeRegistry.abortAll`）。
- `tests/helpers/taskContinuationDependencies.ts`：依赖袋原样迁入（它取 collaboration composition 的类型，只在用例侧合法）。

## 6. public 收口

迁移后 task-execution 的 public 入口里，模块外生产消费方只剩 `services/task.ts` 的符号撤出（design §3 常驻规则 12）；精确清单以计数复核
（`unconsumedPublicSymbols` 不升）为准。按消费方普查预计：`public/operations` 的 `mintNodeRun`、`setTaskStatus`；`public/participants` 的
`taskExecutionModule`、`createLocalEffectAttemptObserver`、`setNodeRunStatusInTransaction`、`builtinWorkflowSyncPreview`、`workflowSyncGateReason`、
`createTaskPreparationParticipantInTx`；`public/queries` 的 `createRunHistoryBatchSnapshot`、`createTaskDetailQueries`、`createTaskPreparationQueries`、
`resolveTaskLaunchRuntimeConfiguration`、`TaskLaunchConfigurationQueries`。用例里取这些符号的改取定义处。不新增 public 符号。

## 7. 用例、账本与清单

- **新增 `tests/rfc478-task-service-retirement.test.ts`**：`services/task.ts` 不在；backend 的 src / 用例 / 脚本零 import（`preProcessFile`
  取全部模块引用，带负对照）；各包、e2e 与仓根脚本零路径字面量（注释不算，带负对照）、workflow 不按完整路径指它；`design/` 与
  `docs/` 的 Markdown 相对链接不指它（带负对照）；census 的 `R1` 里没有它（带负对照）；新文件按内容分层（定义处导出清单；domain
  不取 `node:` / `@/db` / `drizzle-orm`；application 不取 infrastructure 与 legacy）；新 infrastructure 文件不取 source-control 的
  `composition` 或内部（带负对照）；准备依赖的绑定必填（类型字面量）；撤出的 public 符号不在；测试专用出口只在 `tests/helpers/`；
  行为：预览读端口与原四处读取同值、`groupCachedRepoIds` 与原组解析同值、空清理账本与 source-control 构造的逐字段相等（双引擎）。
- **受影响用例**：45 个 import 方改取新位置（`getTask` 14、`abortAllActiveTasks` 17、`isTaskActive` 9 等）；41 个以路径字面量读它的
  源码守卫改指新文件、判据不变（不再成立的「`services/task.ts` 不得包含 X」改锁新文件，或随文件消失删除并在头注说明）；造绑定的
  用例与 helper 补 `groupCachedRepoIds`（`tsc` 兜底）；`rfc476` / `rfc477` 用例里把 `services/task.ts` 当「同前缀但不在退役清单」负对照的
  Markdown 链接 fixture 改用仍在的文件。
- **账本**：`architecture/commons-debt.json` 删 9 条；`commons-manifest` 若有指它的条目改指新位置；`tests/architecture/architectureReport.ts`
  的 owner 表删条目；`architecture/counts.json` 按 C13 收紧触及的减速带（预计 `legacy-horizontal-files` 167、
  `legacy-service-implementations` 48，以实测为准）。
- **文档链接**：`design/RFC-294-backend-layered-target-architecture/review-2026-10-14.md` 指向它的一处 Markdown 链接改为纯文本（dated
  review 保留原叙述）；源码与用例里指向它当前位置的注释改指新位置，叙述历史的注释保留原名。

## 8. 对 RFC-294 刷新后规则的对账

- **C10**：见 §1；新增 application 文件不取 infrastructure；infrastructure 只导出端口实现、读投影与写入协议。
- **C11**：public 只撤不增。
- **C12**：结构锁的覆盖范围写进 plan 的集中验证。
- **C13**：收口时收紧触及的减速带。
- **plan §0 第 8 条**：plan 的计数复核按 design §14 的不变量报告，`R1` / `services/` 计数只作 W9-D 的退出门之一。
- **plan §0 第 10 条**：开工前核对——上次 dated review 2026-11-09，其后关闭 2 个后继（RFC-476、RFC-477），未到期；下一次不晚于 2026-11-23。
- **偏离**：design §5.6 把 `taskRouteLaunchOperations.ts` 记在 W4-E1 名下，本 RFC 不做（理由见 proposal §6 第 1 条），按授权记为已确认。

## 9. 失败模式

- 漏改某个消费方或绑定实现 → `tsc` 报错（绑定必填、`groupCachedRepoIds` 必填）；路径字面量与 Markdown 链接由 RFC-478 用例锁。
- 新 infrastructure 文件直接取 source-control `composition` → 跨 context 内部文件对计数与 RFC-478 用例报出。
- 预览读端口与原读取不等价（例如漏了 `topLevelOnly` 或 `statusIn`）→ RFC-478 用例的同值断言与 `rfc109` / `rfc359-w58` 预览用例报出。
- 撤出 public 符号漏掉某个模块外消费方 → `tsc`；该撤未撤 → 计数复核的未消费 public 符号报出。

## 10. 测试策略

既有的延后准备（`rfc287-t13` / `t14` / `t14b`、`rfc359-w5hn`、`rfc363` 一族）、同步预览（`rfc109`、`rfc359-w58`）、任务详情与失败码
（`rfc203`、`rfc395-a7`）、运行时选项（`rfc103`、`rfc266`、`rfc269`、`scheduler-subagent-live-capture-passthrough`）用例照常覆盖行为，都改走
新位置；新增 RFC-478 用例锁结构与三处端口的同值。集中验证按 RFC-477 的做法：导出仓库里全量 SQLite、PostgreSQL lane、P0 变异
lane、四个包、计数复核与同一时刻的对照。
