# RFC-456 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`TE/` = `S/modules/task-execution/`，
`RC/` = `S/modules/resource-catalog/`，`CO/` = `S/modules/collaboration/`，`SO/` = `S/modules/system-operations/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 只剩到期删除的一跳 facade——实现文件按 owner 归位。RFC-455 做了资源包一族；本 RFC 做「只有一个
  owner、整体能走」的一批：生产 importer 只在一个模块（或装配根）、对外依赖都在目标 DAG 给出的边上、迁走后既不让留下的 `services/` 文件反取
  模块内部（`R1`），也不让模块反取留下的 `services/` 文件（`R2`）。筛选脚本按 import 图求不动点，得出 15 个文件；其中 `agentDeps` 是 RFC-345 登记的兼容债（继任合同是 resource-catalog 的
  `AgentDependencyQueries`，归 W4-E1），挪进 task-execution 只是把债挪走，留下，余 14 个。
- 层按内容：纯判定进 `domain`；用例与步骤进 `application`；带进程级状态、文件或进程副作用的进 `infrastructure`；只做装配的进 `composition`；
  与业务无关的通用机制进 `platform`。
- 不新增目标 DAG 之外的边，不新增 public 导出；装配根继续不直取任何模块的 `infrastructure/`。

## 1. 文件去向

| 原位置                               | 新位置                                                 | 说明                                                                                                          |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `L/sessionModeFallback.ts`           | `TE/domain/sessionModeFallback.ts`                     | 续接会话 id 的回退判定（纯）                                                                                  |
| `L/humanGateContinuationEffects.ts`  | `TE/application/drive/humanGateContinuationEffects.ts` | 人工门续跑的预驱动步骤工厂（与 `gateContinuationEffectStep` 同目录）                                          |
| `L/execution/runtimeConfigFreeze.ts` | `TE/composition/runtimeConfigFreeze.ts`                | 运行时二进制配置冻结（取 TE `composition.ts` 与 `public/queries`，只被 composition 用）                       |
| `L/execution/childBudget.ts`         | `TE/infrastructure/childBudget.ts`                     | 子任务预算（进程级单例；取 TE 的 Drizzle 查询）                                                               |
| `L/execution/executionWatch.ts`      | `TE/infrastructure/executionWatch.ts`                  | 任务终态等待（进程级登记表；取 TE 读模型）                                                                    |
| `L/daemonGeneration.ts`              | `S/platform/execution/daemonGeneration.ts`             | 本守护进程这一代（模块加载时铸一次）的进程身份                                                                |
| `L/scriptAuthorGate.ts`              | `RC/domain/scriptAuthorGate.ts`                        | `scripts:author` 门（shared 判定 + `ForbiddenError`，纯）                                                     |
| `L/codeHostAuthorGate.ts`            | `RC/domain/codeHostAuthorGate.ts`                      | `code-host-calls:author` 门（同上）                                                                           |
| `L/resourceCopyName.ts`              | `RC/domain/resourceCopyName.ts`                        | 复制资源的命名（纯）                                                                                          |
| `L/scheduledTaskRefs.ts`             | `RC/domain/scheduledTaskRefs.ts`                       | 「哪些定时任务行引用了这个资源」（纯）                                                                        |
| `L/pluginGenerationGc.ts`            | 并入 `RC/composition/pluginGenerationGc.ts`            | 兼容包装：`createPluginGenerationFilesystemGcPort` 是恒等转发、`runPluginGenerationGc` 补默认宽限期与回执映射 |
| `L/humanGateDecisionE2eBarrier.ts`   | `CO/infrastructure/humanGateDecisionE2eBarrier.ts`     | 编译期 e2e 崩溃屏障（读环境变量、写标记文件）                                                                 |
| `L/controlListener.ts`               | `S/platform/execution/local/controlListener.ts`        | 守护进程停机控制通道（控制文件、本机 HTTP、硬杀兜底；两端分别被宿主生命周期与 `stop` CLI 使用）               |
| `L/managedPeriodicJob.ts`            | `S/platform/background/managedPeriodicJob.ts`          | 通用定时作业（可注入计时器、下次延迟上下限校验、停止句柄）                                                    |

`services/execution/` 余 13 个文件，不变空；`services/` 下没有目录变空。

## 2. 消费方改指

- **task-execution 内**：`composition/agentNodeExecution.ts`
  取 `domain/sessionModeFallback`；`composition/gateContinuationPreDrive.ts` 取 `application/drive/humanGateContinuationEffects`；
  `composition/localTaskAgentRunFamily.ts` 取 `composition/runtimeConfigFreeze`；`composition/childCallNodeExecution.ts` 与
  `composition/actionExecutionEnvironment.ts` 取 `infrastructure/childBudget`、`infrastructure/executionWatch`；`composition.ts` 取
  `platform/execution/daemonGeneration`。
- **装配根**：`daemonHttpComposition.ts` 的 `setChildTaskBudgetCapacity`、`daemonSession.ts` 的 `notifyChildBudgetTaskStatus` 与
  `notifyTaskTerminal` 改取 TE `composition.ts`（`composition.ts` 再导出这三个进程级钩子）；四个装配根文件的 `DAEMON_GENERATION` 改取
  `platform/execution/daemonGeneration`；`maintenanceWorkerGraph.ts`、`maintenanceJobBindings.ts` 改取 RC `composition/pluginGenerationGc`。
- **resource-catalog 内**：`infrastructure/workflowMutationParticipant.ts` 取 `domain/{scriptAuthorGate,codeHostAuthorGate}`；
  `composition/workgroupOperations.ts` 取 `domain/{resourceCopyName,scheduledTaskRefs}`；`infrastructure/{agentPersistenceSemantics,
workflowPersistenceSemantics,legacy/workflow}.ts` 取 `domain/scheduledTaskRefs`。
- **collaboration 内**：`infrastructure/{review,clarify/autoDispatch,taskQuestionDispatch}.ts` 取 `infrastructure/humanGateDecisionE2eBarrier`。
- **system-operations 与 CLI**：`infrastructure/local/{epochSwitchQuiesce,nativeDaemonStartupLease,nativeDaemonHostLifecycle}.ts` 与
  `cli/stop.ts` 取 `platform/execution/local/controlListener`（CLI 取平台不算 `R1`；进 system-operations 的 `infrastructure` 则会新增一条）。
- **source-control 内**：`infrastructure/local/repositoryMirrorAutoRefresh.ts` 取 `platform/background/managedPeriodicJob`。
- **用例**：经旧路径取的用例改取新位置；按路径片段读源码的锁改指新位置（迁移前全仓搜文件名本身，见 `docs/dev-gotchas.md`
  RFC-454 / RFC-455 条目）。

## 3. 用例

- **新用例** `T/rfc456-services-single-owner-placement.test.ts`：14 个旧文件不存在、`S/` 与用例零引用旧路径（census AST，别名与相对路径
  都认，带负对照）；装配根（`bootstrap/**`、`main.ts`、`server.ts`）零 import 任何模块的 `infrastructure/`；TE `composition.ts` 再导出的
  三个钩子就是 `infrastructure` 那一份（恒等断言）；`platform` 的两个新文件不取 `modules/`；`DAEMON_GENERATION` 在进程内稳定、显式代际优先；
  RC composition 的 `runPluginGenerationGc` 补上 24 小时默认宽限、转发显式 `now`、返回回执里的路径；`pluginGenerationGc` 包装函数不再
  有第二份定义。
- **随迁的守卫表**：架构报告的 legacy 归属表删去这些文件；按路径读源码的锁改指新位置；guard-manifest 刷新行数。
- **账本**：`commons-debt.json` 的 `R1`（`services/` → 模块内部：子任务预算 / 终态等待 / 配置冻结 / 人工门续跑 / 插件 GC 取模块内部的边）按
  实测销账；`R2` 只数 application / domain / engine / public 取 `@/services/` 的边，这 14 个文件的消费方都在 infrastructure / composition，
  预期不变。
- 文档：`docs/env-flags.md`（`AW_E2E_BUILD` 的消费方路径）、`docs/audit-backlog.md` 里描述现状的路径改指新位置，带日期的历史记录不动。

## 4. 留下的债

- `agentDeps`：RFC-345 登记的兼容债，随 W4-E1 改由 resource-catalog 的 `AgentDependencyQueries` 承担后删除。
- 带越界依赖的单 owner 文件：`limits`（取 system-operations 的审计端口类型；归 task-execution 需要先决定审计端口的归属）、`demoSeed`
  （组合 resource-catalog / system-operations / code-capability 的种子参与者，属于装配根的生命周期步骤）、`ownerScopedName`（取 identity-access
  的 composition）、`taskLaunchGate`（经三个一跳转出取 resource-catalog）。
- 依赖仍留在 `services/` 的文件：运行时驱动一族（`services/runtime/**`）与依赖它的 task-execution 文件、`envelope` / `agentLaunch` /
  `ref/runtimeRef` 的使用者、`services/task.ts`（E1）。
- task-execution 的 `public/queries#freezeRuntimeBinaryConfiguration` 与 `public/participants#TaskExecutionError` 此前唯一的外部消费方是
  迁走的两个文件，迁入后只剩同 context 消费（架构报告「没有跨 context 生产消费方的 public 符号」320 → 322，不设门）；是否从 public 收回
  留给 public surface 的清理波次（task-execution 内部经自己的 public 入口取用的文件另有 44 个，属同类写法，一并处理）。

## 5. 失败模式

- 漏改的消费方：tsc 兜底（旧文件删除后取不到）；用例经新用例的零引用断言兜底；按路径片段读源码的锁按文件名本身全仓搜。
- 从留下的文件里拆走一段（`pluginGenerationGc` 并入 composition）：按被拆走的声明名搜文本断言（`docs/dev-gotchas.md` RFC-455 条目）。
- 装配根取到模块内部：新用例对 `bootstrap/**` 全量断言。
- 新增越界：`module-layer-violations`、off-DAG、跨 context 内部文件对与 public surface 偏差的精确清单兜底。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
