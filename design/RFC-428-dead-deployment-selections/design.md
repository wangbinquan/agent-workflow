# RFC-428 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-427 落库后的源码（`c96f2c907`）为准。

## 1. 选择项与键表

- `S/bootstrap/deploymentProfile.ts`：`DeploymentSelections` 删去 `databasePreOpenRecovery`、`nodeRunPromptContentEffects`、
  `portArtifactContentEffects`、`startupLease`，以及只为它们存在的类型导入。
- `S/bootstrap/deploymentSelections.ts`：`DEPLOYMENT_SELECTION_KEYS` 删去这四项。键表与接口的逐项相等仍由 RFC-394 锁保证。

## 2. 各消费点

| 选择项                        | 改动                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startupLease`                | `S/modules/system-operations/composition.ts` 的 `composeDaemonStartupLease({ local })` 只装本地原生锁：`acquireDaemonStartupLease(createNativeDaemonStartupLease(input.local()))`；`S/bootstrap/daemonStart.ts` 不再传 `selected` |
| `databasePreOpenRecovery`     | `daemonStart.ts`：未选数据库安装时照旧 `applyLocalEpoch2PendingRestore`，删去从不执行的选择分支                                                                                                                                   |
| `nodeRunPromptContentEffects` | `S/bootstrap/daemonApplication.ts` 的本地任务根：`composeNodeRunPromptOperations(undefined, join(appHome, 'runs'))`                                                                                                               |
| `portArtifactContentEffects`  | `daemonApplication.ts` 的本地任务根：`composePortArtifactOperations(undefined, appHome)`；`S/modules/task-execution/composition/crewstationExecution.ts` 的托管选择删去这个属性，托管的端口制品仍在 `taskRunSelection` 里         |

`DaemonDatabasePreOpenRecoveryPort` 仍被 system-operations 的 `recovery` 入参使用，类型保留。

## 3. 守卫

- **新增结构锁** `T/architecture/rfc428-retired-deployment-selections.test.ts`：
  - `DeploymentSelections` 的成员与 `DEPLOYMENT_SELECTION_KEYS` 的键都不含这四个名字；
  - `composeDaemonStartupLease` 的入参不含 `selected`；
  - 负例两组：既有语料替换与纯伪造单元。
- **guard-manifest**：新增一条；改动的守卫刷新行数。

## 4. 测试

- **启动锁**：
  - `rfc370-daemon-startup-lease` 的「被选锁」用例改为直接调用 `acquireDaemonStartupLease` / `runDaemonStartupWithLease`，断言不变；
  - 另加一例：`composeDaemonStartupLease` 只构造本地锁。
- **启动根**：
  - `rfc370-startup-lease-root-wiring` 改为断言启动根只传 `local`；
  - `rfc394-start-sequence` 的夹具改为替换 `composeDaemonStartupLease`，不再经选择项注入假锁。
- **端口制品 / 节点提示**：`rfc370-port-artifact-bindings`、`rfc370-task-run-root-content`、`rfc370-node-run-prompt-bindings` 里经选择项注入的
  用法改为模块级注入或删去，等价断言保留。
- **部署 profile**：`rfc394-deployment-profile` 的托管键集合 69 → 68；`T/helpers/providerHttpApplication.ts` 的可传入键列表删去该项；
  `T/helpers/deploymentSelectionSource.ts` 的「保持可选」清单删去这四项。
