# RFC-534 技术设计

## 1. 现状（HEAD `4d938230a`，源码实读）

- **登记步**：`bootstrap/daemonLifecycleProgram.ts` 的 `DAEMON_BOOT_STEPS` 第 2 步 `process-registrations`（prepare、fail-closed）；
  `bootstrap/daemonApplication.ts` 的实现调 `registerTerminalWorkspacePrunePolicy(composeWebhookTerminalWorkspacePrunePolicy({ db, enabled }))`
  （`enabled` 每次重读配置的 `webhookTaskWorkspaceAutoCleanup`）与 `setMemoryDistillPolicyProvider(...)`（每次重读配置、解析失败回落
  `DEFAULT_DISTILL_POLICY`）。生命周期程序交给运行期会话的 `beforeResume` 只做一件事：恢复执行前重跑这一步
  （`daemonProviderRuntimeSession.ts` 在启动各 handle 之前 `await input.beforeResume?.()`）；`rfc379-daemon-lifecycle` 钉“恢复时重登记”（3 次）。
- **回收策略**（`modules/task-execution/infrastructure/terminalWorkspacePrune.ts`）：模块级 `let terminalWorkspacePrunePolicy`、
  `registerTerminalWorkspacePrunePolicy`；`resolveTerminalWorkspacePruneDecision(row, to)` 在策略为空或 `to` 不是 `done` / `canceled` 时给
  `{ prune: false }`，策略抛错时记告警并给 `{ prune: false }`。读者四处，都在事务外算好再交进 CAS：
  1. `DrizzleTaskRuntimeLifecyclePersistence`（`infrastructure/taskRuntimeLifecyclePersistence.ts`，由 `composition/taskExecutionPersistence.ts` 的
     `createTaskRuntimeLifecyclePersistence` 建，`createTaskExecutionPersistence` 用它；daemon 与维护 Worker 各建一份）；
  2. 取消 `cancelTaskProjection`（`infrastructure/childTaskLifecycleParticipant.ts`，依赖里带会话的 `persistence`）；
  3. 源终止 `applySourceTerminationTarget`（`infrastructure/sourceTerminationTarget.ts`，由 `createTaskSourceTerminationParticipant` 调，
     daemon 的 integration 装配经 `composeTaskSourceTermination` 建）；
  4. 遗留的 `setTaskStatus`（`infrastructure/taskLifecycle.ts`）：生产里只有延迟仓库准备的失败路径调它（转 `failed`，策略对它本来就不回收），
     其余是用例。
- **维护 Worker**（`bootstrap/maintenanceWorkerGraph.ts`）是 `new Worker` 起的另一个 realm，主线程的登记到不了：Worker 的 task-execution 持久化里
  策略恒为空。它经恢复管理面只写 `interrupted`，本来也不会回收。
- **蒸馏策略**（`modules/memory/application/distill/schedule.ts`）：模块级 `let memoryDistillPolicyProvider`（缺省 `DEFAULT_DISTILL_POLICY`）、
  `setMemoryDistillPolicyProvider`、`resetMemoryDistillPolicyProviderForTest`；`enqueueDistillJob(store, input)` 入队前读它。生产里唯一的调用方是
  `modules/memory/composition.ts` 的 `distillCommands.enqueue`（`composeMemoryOperationsFor` 建）。
- 架构报告的模块级可变单例清单里这两个文件 5 条：`terminalWorkspacePrunePolicy`、`registerTerminalWorkspacePrunePolicy`、
  `memoryDistillPolicyProvider`、`setMemoryDistillPolicyProvider`、`resetMemoryDistillPolicyProviderForTest`。

## 2. 机制与落位

### D1 回收策略是 task-execution 持久化的必填依赖

- `terminalWorkspacePrune.ts` 删去模块级变量与登记函数；`resolveTerminalWorkspacePruneDecision(policy, row, to)` 显式收策略（判定与抛错时的告警
  逐字不变）；导出具名的 `neverPruneTerminalWorkspaces`（任何转移都给 `{ prune: false }`），由 `composition.ts` 转出。
- `TaskExecutionPersistenceDependencies` 加必填的 `terminalWorkspacePrune`（与 RFC-526 必填的 `workspacePresence` 同处）：
  `createTaskRuntimeLifecyclePersistence` 交给 `DrizzleTaskRuntimeLifecyclePersistence` 的构造参数；聚合 `TaskExecutionPersistence` 带着它
  （只读成员），取消路径读会话 `persistence` 上的这一份。
- 源终止：`TaskSourceTerminationParticipantInput` 加必填的 `terminalWorkspacePrune`，`applySourceTerminationTarget` 收它。
- 遗留写者：`setTaskStatus` 的入参加必填的 `terminalWorkspacePrune`（`trySetTaskStatus` / `transitionTaskStatusByEvent` 原样转交）；延迟仓库准备的
  依赖 `DeferredRepositoryPreparationDependencies` 加必填的同名字段并交给它。
- 人工关口的停靠：collaboration 经 `TaskExecutionParticipantBindings` 调 `parkPreparedHumanGate`，那里建运行期生命周期写者，同样交会话的这一份
  （停靠不会转入 `done` / `canceled`，与 RFC-526 的 `workspacePresence` 同路）：`composeCrossContextClosure` / `composeTaskExecutionParticipantBindings`
  多收这一份；task-execution 的 daemon 模块集合带着它，daemon 会话与 HTTP 装配的参与者绑定从那里取。
- 装配：`daemonApplication.ts` 在装配 task-execution 之前以本会话的库与配置组合 webhook 回收策略一次，交给
  `composeDaemonTaskExecutionModules`（进持久化依赖、跨上下文闭包与延迟仓库准备）与 `composeDaemonIntegrationModules`（进源终止）；维护 Worker
  交 `neverPruneTerminalWorkspaces`（与此前恒为空逐字等价）。

### D2 蒸馏策略是 memory 组合的必填输入

- `schedule.ts` 删去模块级变量、setter 与 reset；`enqueueDistillJob(store, policy, input)` 显式收策略读取器 `MemoryDistillPolicySource`
  （`() => DistillPolicy | Promise<DistillPolicy>`，与此前的 provider 同形；放在入参之前，调用处的入参对象仍在最后），准入判定逐字不变。
- `ComposeMemoryOperationsOptions` 加必填的 `distillPolicy`；`composeMemoryOperations` 的 `distillCommands.enqueue` 交给 `enqueueDistillJob`。
- 装配：`daemonApplication.ts` 把原来登记的那个读取器（每次重读配置、解析失败回落 `DEFAULT_DISTILL_POLICY`）交给 `composeDaemonMemoryModules`。

### D3 删去登记步

- `DAEMON_BOOT_STEPS` 删去 `process-registrations`，`daemonApplication.ts` 删去它的实现；生命周期程序不再交 `beforeResume`，运行期会话的输入
  删去这个可选钩子与它的调用（再没有别的使用方）。
- 两份会话各自装配自己的策略，暂停 / 恢复之间没有进程级状态可被别的会话改写，恢复前也就不必重登记。

### D4 用例与锁

- 新增 `tests/rfc534-session-process-registrations-boundary.test.ts`，登记 guard-manifest：① 两个文件顶层没有 `let`，没有导出的
  `register*` / `set*` / `reset*`；生产代码不再引用删去的名字；`DAEMON_BOOT_STEPS` 没有 `process-registrations`，运行期会话的输入没有
  `beforeResume`；daemon 把同一份回收策略交给 task-execution 与 integration 的装配、把蒸馏策略交给 memory 的装配；维护 Worker 交
  `neverPruneTerminalWorkspaces`（语料下限 3,000）；② 行为：两份持久化各用各的策略；`resolveTerminalWorkspacePruneDecision` 对非终态与策略抛错
  给不回收；两份 memory 组合各用各的蒸馏策略；带负对照。
- 读旧形状的锁与用例随改：登记 / 设置策略的用例改为把策略交进各自用的装配；构造持久化依赖、源终止输入、延迟准备依赖与 memory 组合输入的
  用例补上新字段（不关心回收的交 `neverPruneTerminalWorkspaces`，不关心蒸馏的交 `() => DEFAULT_DISTILL_POLICY`）；钉启动步清单与“恢复时重登记”
  的 `rfc359-w3-t15`、`rfc395-epoch2-boot-step-contract`、`rfc379-daemon-lifecycle` 随改。

## 3. 清单（退出门）

| 名字                                                                                                         | 之后                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `terminalWorkspacePrunePolicy` / `registerTerminalWorkspacePrunePolicy`                                      | 删去；持久化、源终止与遗留写者的必填依赖    |
| `memoryDistillPolicyProvider` / `setMemoryDistillPolicyProvider` / `resetMemoryDistillPolicyProviderForTest` | 删去；memory 组合的必填输入，入队时显式交入 |
| `process-registrations` 启动步与 `beforeResume`                                                              | 删去                                        |

## 4. 用例

- ① ～ ② 见 D4；既有用例覆盖 webhook 工作区回收（`rfc300-*`、`rfc370-terminal-workspace-policy-query`）、源终止（`rfc359-w12-source-termination-atom`、
  `rfc359-w8-source-termination-conformance`）、蒸馏准入（`rfc366-execution-end-enqueue`、`memory-distill-*`）与启动程序（`rfc379`、`rfc395-epoch2-*`）。

## 5. 失败模式

- **漏交策略**：字段必填，`tsc` 管住类型检查得到的装配点；以 `as unknown as` / `as never` 伪造依赖的用例按 `docs/dev-gotchas.md` 全仓搜一遍补上。
- **生产装配交错了策略**：RFC-534 用例钉 daemon 把同一份回收策略交给两处装配、维护 Worker 交从不回收。
- **恢复后用到别的会话的策略**：策略随会话装配，不再有进程级状态。

## 6. 取舍（可推翻）

1. **策略是依赖，不改成事件**：回收认领要与终态转移同一笔 CAS（取消与源终止的注释写明了为什么），改成事后消费者会改变原子性。
2. **取消路径从会话的持久化聚合上取策略**：取消本来就收会话的 `persistence`，不另开一条依赖链；源终止与遗留写者没有聚合，显式收。
3. **维护 Worker 交具名的从不回收**：与此前恒为空逐字等价；Worker 只写 `interrupted`，交真实策略也不会回收，不扩大行为面。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交（不加判断）。**C11**：task-execution 的 public 类型不变（`TerminalWorkspacePrunePolicy` 早已是 public 类型），
  composition 多转出一个具名策略；memory 的组合输入多一个必填字段。**C12**：RFC-534 用例覆盖。**C13**：计数不升，模块级可变单例 71 → 66。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第二步（进程登记的两条策略，5 条），删去登记步。
- **留下**：其余 66 条（执行看门、按对象挂的侧表、`transport-projections` 等其余登记、platform / util 的进程级缓存；后者需要保留的由后继
  design 提出、经用户确认后修订 §14 口径）。
