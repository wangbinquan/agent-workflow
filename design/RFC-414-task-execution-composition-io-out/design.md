# RFC-414 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`。行号以 RFC-413 落库后的源码为准，实施时按源码
定位。形状沿用 RFC-405～413：主体原样迁移，只做落位；装配在 composition。

## 1. 文件

| 来源（`TE/composition/`）                                                                                                             | 去向                                                                                                                                        | 说明                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspacePreparationMaintenance.ts` 的孤儿 / scratch GC 相位（扫 `task_workspace_preparations`、前缀与年龄筛选、逐条补偿、合并回执） | `TE/infrastructure/workspacePreparationGc.ts` 的 `runWorkspacePreparationGcPhase(input, request)`                                           | composition 的 `composeWorkspacePreparationMaintenance` 只判相位并委托；`createWorkerWorkspaceMaintenanceCommand` 不动                              |
| `crewstationExecution.ts` 的 `owner` 里读 `tasks.worktree_path`                                                                       | `TE/infrastructure/taskExecutionTaskReads.ts` 的 `readTaskWorkspaceRef(db, taskId)`                                                         | 判定与 `locate` 留在 composition 的绑定                                                                                                             |
| `crewstationRecovery.ts` 的 `taskStatus`、`actionExecutionRunners.ts` 的 `readTaskStatus`                                             | 同上文件的 `readTaskStatus(db, taskId)`                                                                                                     | 两处原本是同一条查询，合为一份                                                                                                                      |
| `actionExecutionRunners.ts` 的 `localWorkspaceEntries`（`existsSync`）                                                                | `TE/infrastructure/local/localActionWorkspaceEntries.ts`                                                                                    | 原样迁移                                                                                                                                            |
| `digitalEmployeeExecution.ts` 的 `inspectDigitalEmployeeHumanReviewSnapshot` 与 `executionMetadata.load` 的库读                       | `TE/infrastructure/digitalEmployeeExecutionReads.ts`（`inspectDigitalEmployeeHumanReviewSnapshot`、`readDigitalEmployeeExecutionMetadata`） | composition 的 `composeDatabaseDigitalEmployeeExecutionPorts` 只绑定                                                                                |
| `nodeExecution.ts` 的 `getCanonicalFilesChanged`（逐仓 `worktreeFilesChanged` 求和）                                                  | `TE/infrastructure/local/canonicalDelta.ts` 的 `countCanonicalFilesChanged(repos)`                                                          | 错误文本与求和不变                                                                                                                                  |
| `taskImageExecution.ts`、`taskImageArchive.ts`                                                                                        | `TE/infrastructure/crewstation/taskImageExecution.ts`、`taskImageArchive.ts`                                                                | 原样迁移；composition 保留同名文件只做再导出（bootstrap 只依赖 composition / public）                                                               |
| `portOutputValidation.ts` 的 `resolveNativePortContentDetailed`                                                                       | `TE/infrastructure/local/filePortOutputValidation.ts`                                                                                       | 它把 native IO 绑进校验策略，本就是 infrastructure；composition 保留再导出，迁走的托管镜像操作直接取 infrastructure 那份，不反向 import composition |

## 2. 结构锁

新增 `T/architecture/rfc414-composition-io-out.test.ts`：

- task-execution `composition/` 的任何文件不 import `drizzle-orm`、`@/platform/persistence/sessionTables`、`@/platform/persistence/queryHelpers`、`node:fs`、
  `node:fs/promises`、`node:child_process`、`@/util/git`，源码不出现 `tablesOf(`、`Bun.spawn(`；
- 新 infrastructure 符号 owner 唯一；`readTaskStatus` 只有一份；
- 每条规则带纯伪造输入的负例。

## 3. 必须保持

| 不变量                                                                                                                                                             | 现有锁 / 用例              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| GC：只扫 `lane = pre-materialized` 且未认领、前缀匹配、未 cleaned；活跃与不满 24 h 的跳过；补偿失败只告警；未完成的计划并入活跃集交给 source-control；回执三项相加 | 工作区准备 / 维护用例      |
| 托管工作区归属：未绑定工作区退回 taskId，否则按 `locate` 取物理 owner                                                                                              | RFC-370 托管执行用例       |
| 人审闸门六态与元数据两列                                                                                                                                           | RFC-359 / 368 数字员工用例 |
| 零增量告警：无 base commit 时抛同一错误，逐仓求和                                                                                                                  | RFC-187 用例               |
| 托管镜像操作的路径校验、拒绝码、返回形状                                                                                                                           | RFC-370 托管镜像用例       |

## 4. 守卫与账本

按旧路径取语料的锁改读新 owner（`rfc187-zero-delta-done` 的 `NODE_EXECUTION_SOURCE` 锚点等）；commons-debt / 跨 context 文件对 / guard-manifest /
Windows paths 按实测更新。

## 5. 测试

- 结构锁见 §2。
- 端口绑定用例 `T/rfc414-port-bindings.test.ts`：`readTaskStatus` / `readTaskWorkspaceRef` / 数字员工两读在两 provider 上对拍；GC 相位用伪造
  维护命令与内存库驱动跳过 / 补偿 / 回执合并；`countCanonicalFilesChanged` 的空 base 报错。
- 搬迁涉及的既有用例只改 import 与源码锚点。
