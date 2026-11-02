# RFC-424 技术设计

路径缩写：

| 缩写 | 路径                       |
| ---- | -------------------------- |
| `S`  | `packages/backend/src`     |
| `TE` | `S/modules/task-execution` |
| `T`  | `packages/backend/tests`   |
| `H`  | `T/helpers`                |

行号与行数以 RFC-423 落库后的源码（`128e439d7`）为准。

## 1. `S/services/task.ts` 删除清单

| 声明                                                                                                                                                                                                                                                                                                                                 | 行数 | 去向                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------- |
| `composeTestTaskDriveFactory`、`TaskDriveCoordinatorDependencies`（类型）、`missingMemoryDistillEnqueuer`                                                                                                                                                                                                                            | 115  | 逐字迁入 `H/legacyTaskDrive.ts`         |
| `wakeHumanGateContinuation`                                                                                                                                                                                                                                                                                                          | 19   | 逐字迁入 `H/legacyTaskDrive.ts`         |
| `resumeDynamicWorkflowExecution`；`resumeKick` 与只为它存在的 `continuationSource`、`submitContinuationIntentInTx`、`rollbackNodeRunForResume`、`escalateSnapshotLost`、`reapRunBeforeWorktreeReset`、`reapHeldRuntimeSessionOwnersForTask`、`escalateLiveChildSurvived`、`assertChildTaskDrivable`、`requireTaskRecoveryOperations` | 474  | 删除；两个用例改走生产确认命令（§3）    |
| `retryRepositoryPreparation`、`repositoryWorkspaceFor`                                                                                                                                                                                                                                                                               | 48   | 删除；`H/retryEngine.ts` 自行装配（§2） |
| `selectResumeRollbackTargets`（单参数包装）                                                                                                                                                                                                                                                                                          | 19   | 迁入 `H/resumeRollbackTargets.ts`       |

不再使用的 import、`taskDriveLegacy` 解构项与类型别名随之删除。保留的函数（延后仓库准备、同步预览、快照排版、`getTask`、`isTaskActive`、
`abortAllActiveTasks`、`shutdownActiveTaskExecutions`、`runtimeConfigOpts` 等）一字不改。

生产注释里把 `services/task.ts` 的 `escalateSnapshotLost` / `escalateLiveChildSurvived` 称为「权威实现」的地方
（`TE/infrastructure/taskRouteOperations.ts` 的分节注释）改为指向生产实现：resume 在 `childTaskLifecycleParticipant.ts`，retry / sync 在
`taskRouteOperations.ts`。

**随之死掉的生产代码**：`S/modules/resource-catalog/infrastructure/legacy/workgroup/state.ts`（405 行）与它的再导出 facade
`S/services/workgroup/state.ts`，唯一的生产消费者是被删的 `resumeDynamicWorkflowExecution`（`setDwStateTx`）。两者删除，模块原样迁入
`H/legacyWorkgroupState.ts`（只把 `../agent` 改为绝对路径）；否则 RFC-376 的「不可达生产文件」会 27 → 29、RFC-345 的「零消费者 facade 必须退役」
也会报红。

`TE/composition/taskDriveLegacy.ts`（RFC-332 留给 `services/task.ts` 的兼容命名空间）删去随之失去最后使用方的再导出（驱动生命周期函数、
仓库准备重试命令、持久化装配等 14 项）；被再导出的源文件都另有生产引用方，不会因此变成不可达文件。

## 2. 测试侧装配

- **`H/legacyTaskDrive.ts`**：接收 `composeTestTaskDriveFactory`（及其依赖类型与缺省的记忆蒸馏入队器）与 `wakeHumanGateContinuation`，
  主体逐字迁移，import 改为模块 composition / application / public 与 `services/task.ts` 保留的导出（`runtimeConfigOpts`、
  `TaskContinuationDependencies`、`getTask`）。文件头注释改写为「测试侧装配生产组件」。
- **`H/retryEngine.ts`**：仓库准备重试由 helper 自行装配：`composeTestTaskDriveFactory`（工厂）+ task-execution composition 的
  `composeDeferredRepositoryPreparation`（生产的延后仓库准备步骤）+ 生产的 `createRepositoryPreparationRetryCommand`。`retryEngine`
  一向会传 `repositoryPreparation` 绑定，延后准备因此走绑定而不是旧的 `repositoryWorkspace` 回落，与删除前等价。
- **`H/resumeRollbackTargets.ts`**：单参数便利包装（以 `createRunHistorySnapshot` 包 application 的唯一实现），供 4 个用例使用。
- `H/productionTaskLaunch.ts`、`H/hostTaskLaunchKernel.ts` 与 8 个 wake 用例只改 import。

## 3. 动态工作流用例

`T/rfc167-dw-e2e.test.ts` 与 `T/rfc223-pr3b-dynamic-token.test.ts` 的「确认 → 执行」一段：

- 删去手工关 dw-gate holder 与手工拼 `executing` 状态的步骤（生产确认命令自己做）；
- 用 `composeTestWorkgroupTaskRoom(db, { continuation })` 取生产的工作组任务房，`continuation.driveAfterCommit` 以
  `wakeHumanGateContinuation(taskId, intentId, deps)`（`awaitScheduler: true`，带原用例的运行时覆盖）驱动；
- 以任务 owner 的 `DirectAuthenticatedAuthority` 调 `commands.confirmDynamicWorkflow(authority, { taskId, submission })`，提交
  `{ decision: 'approve' }`。

断言不变：任务 `done`、`workflow_snapshot` 等于生成的 DAG、dw 阶段 `executing`、确认后的节点跑完、生成宿主节点不再运行。

## 4. 守卫与账本

- **RFC-386 盘点锁**（`T/architecture/rfc386-drive-factory.test.ts`）：
  - 装配点只剩 `bootstrap/daemonModules/taskExecution.ts#composeDaemonTaskExecutionModules`；
  - 原「test-only 入口不得有生产调用方」改为「退役入口（`startTask`、`wakeHumanGateContinuation`、`resumeDynamicWorkflowExecution`、
    `retryRepositoryPreparation`、`composeTestTaskDriveFactory`）在 src 中不得声明或调用」；
  - 负例：在 src 里重新声明任一退役入口、或在 `services/task.ts` 里重新装配工厂，各自被报出。
- **RFC-103 / RFC-332 源码文本锁**：「配置单源 → 协调器」漏斗改钉 bootstrap：`bootstrap/daemonModules/taskExecution.ts` 恰有一处
  `...runtimeConfigOpts(` 与一处 `createTaskDriveCoordinatorFactory(`；`services/task.ts` 不再含工厂装配与 wake。
- **读 `services/task.ts` 源码文本的其余锁**：逐条核对被删内容。锁住的语义在生产侧仍成立的，改读生产实现（例如 PB-G4 / `scheduler-audit-s02`
  的「resume 回滚走共享权威」改读 `childTaskLifecycleParticipant.ts`，RFC-108 T9 的「存活子进程拒绝续跑」改读生产 resume 与
  retry 两处）；锁住的只是被删代码的形状的，删去该断言并在注释写明理由。
- **路径键账本**：随 import 与调用的删除，账本里 `services/task.ts` 的失效条目按「只减不增」删去：
  - `architecture/commons-debt.json` 的 R1 边四条（215 → 211），`collaboration/composition` 那条只剩类型用途、edgeKind 改为 type；
  - RFC-331 的 legacy 深引两条、RFC-317 allow-terminal 账本一条（总数 21 → 20）、RFC-359 孪生账本的一个 consumer、RFC-345 兼容边一条；
  - legacy 工作组状态退役带出的：`commons-debt.json` 再少一条（211 → 210）、RFC-376 `export-star-barrels` 基线删去该 facade、
    RFC-395 任务定义边界用例改为断言 legacy 文件不在生产树；RFC-317 表归属账本删去该模块的三条跨 context 表引用；RFC-395 两本测试直接
    读写账本登记 `H/legacyWorkgroupState.ts`（类别 `target-runtime-state`，与动态工作流用例同类）；
  - RFC-359 W5-T19f 的单引擎分类：`sqlite-execution-engine` 补一条同义拼法（从 `helpers/legacyTaskDrive` 导入），纯搬迁不改变已裁决用例的分类
    （判据自测补一条正例）。
- **其余按 `services/task.ts` 形状写的源码锁**：PB-G4、`scheduler-audit-s02`、RFC-108 T9、RFC-333 T2、子代理实时捕获透传各改钉生产实现
  （resume 参与者、`taskRouteOperations`、bootstrap 的 run configuration），被删代码本身不再被锁。
- **guard-manifest**：改动的守卫行数按实测刷新；不新增守卫文件。

## 5. 测试

- RFC-386 盘点锁的负例（§4）。
- 迁移后的既有用例即行为覆盖：8 个人工门续跑用例、2 个动态工作流用例（现在经生产确认命令）、`retryEngine` 的全部使用方、4 个回滚目标用例。
- 不新增生产代码，故不新增端口绑定用例。
