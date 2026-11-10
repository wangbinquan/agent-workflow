# RFC-477 设计

**落在哪个 context、哪一层**：task-execution（回滚结果与失败说明、agent 宿主快照进 `domain/`，限额策略进 `application/`，回滚的目标装载与
带 effect 记账的执行进 `infrastructure/`）；resource-catalog（触发预检、停用资源策略进 `domain/`，经 `public/` 交出）；collaboration
（回滚端口进 `application/ports/`，经已有的 `TaskExecutionParticipantBindings` 由 bootstrap 注入）。
**承担的演进**：W9-D 的一步——五个 `services/` 文件退役，`R1` 少 3 条；按 RFC-294 C10 按内容分层落位；collaboration 取回滚改经自有端口；
task-execution 不取 system-operations。
**留下的债**：`task.ts`（RFC-478）、随运行时驱动一族的三个文件、其余 27 条 `R1`（proposal §3）。

## 1. 节点回滚（`services/nodeRollback.ts`）

### 1.1 task-execution

- **`domain/nodeRunRollbackOutcome.ts`**（新）：`RollbackOutcome`（`attempted` 与逐仓 `failures`）与 `snapshotMissingDetail(outcome)`
  （`snapshot-missing` 一类失败的合并说明，用户可见文案），逐字迁入。
- **`infrastructure/nodeRollback.ts`**（新）：其余部分逐字迁入——`RollbackTarget`（带 `taskId` / `db` 时回滚写 RFC-328 effect）、
  `RollbackRunRow`、`PlannedNodeRunRollbackTarget`、`planNodeRunRollbackTargets`、`loadRollbackTarget(db, taskId)`、
  `loadRollbackTargetFrom(queries, taskId)`、`rollbackNodeRunWorktrees(target, run, opts, log)`。对本模块的符号改取定义处：
  `taskRollbackPlan` ← `./taskRollbackCodec`，`hasTaskRollbackCheckpoint` / `TaskRollbackCheckpointRun` ← `../domain/taskCheckpointRollback`，
  `createNodeRollbackEffectObserver` / `loadNodeRollbackTarget` / `NodeRollbackDatabase` ← `./nodeRollbackPersistence`，`TaskRollbackQueries`
  ← `../application/ports/taskRollbackQueries`，`RollbackOutcome` ← `../domain/nodeRunRollbackOutcome`（调用方取 `snapshotMissingDetail` 也改取
  domain）。唯一的签名变化：`rollbackNodeRunWorktrees` 的日志参数从 `Logger` 收窄为它实际只用的 `Pick<Logger, 'warn'>`
  （`NodeRunRollbackLog`），既有调用方传的 `Logger` 照旧满足，collaboration 端口的日志类型因此能按结构声明。
- 新增 **`createNodeRunWorkspaceRollback(db)`**：给 collaboration 的按任务作用域——`load(taskId)` 用 `loadRollbackTarget(db, taskId)`
  （目标带 `db`，回滚写 effect，与 collaboration 今天的调用同一条路径），返回 `{ plan(run), rollback(run, log) }`，分别落到
  `planNodeRunRollbackTargets(target, run)` 与 `rollbackNodeRunWorktrees(target, run, {}, log)`；目标为 null 时返回 null。
  `composition.ts` 转出它（与 `createHumanGateNodeRunMintOperations` 等同列），不上 public。
- task-execution 的两个调用方（`infrastructure/taskRouteOperations.ts`、`infrastructure/childTaskLifecycleParticipant.ts`）改取
  `./nodeRollback`，调用逐字不变。

### 1.2 collaboration

- **`application/ports/nodeRunWorkspaceRollback.ts`**（新，consumer 自有）：

```ts
/** 一个任务的节点回滚作用域：目标装载一次，规划与执行都对着它。 */
export interface NodeRunWorkspaceRollbackScope {
  /** 只规划、不碰工作区：这一轮检查点要回到的工作树 / 快照对。 */
  plan(run: TaskRollbackCheckpointRun): readonly PlannedNodeRunWorkspaceRollbackTarget[]
  /** 执行回滚：逐仓 warn-and-continue，结果里带失败明细。 */
  rollback(
    run: TaskRollbackCheckpointRun,
    log: NodeRunWorkspaceRollbackLog,
  ): Promise<NodeRunWorkspaceRollbackOutcome>
}
export interface NodeRunWorkspaceRollbackPort {
  load(taskId: string): Promise<NodeRunWorkspaceRollbackScope | null>
}
```

`TaskRollbackCheckpointRun` 取 task-execution `public/types`（collaboration → task-execution 是 offered 边，本就在取）；目标、规划结果、
日志与结果的形状在端口里按结构声明，不取 task-execution 内部。

- **`infrastructure/taskExecutionParticipantBindings.ts`**：多一格必填 `createNodeRunWorkspaceRollback: (db: PersistenceDb) =>
NodeRunWorkspaceRollbackPort`（与同一接口里的 `createHumanGateNodeRunMintOperations(db)` 同形）。
- **`infrastructure/review.ts`**：`PreparedRerun.rollbackTarget` 的类型改为 `NodeRunWorkspaceRollbackScope | null`；`planRerun` 里
  `loadRollbackTarget(db, taskRow.id)` 改为经 `args.taskExecutionParticipants.createNodeRunWorkspaceRollback(db).load(taskRow.id)`；
  规划 `planNodeRunRollbackTargets(rerun.rollbackTarget, up.latest.rollback)` 改为 `rerun.rollbackTarget.plan(up.latest.rollback)`。
- **`infrastructure/clarify/autoDispatch.ts`**：自回滚的 `loadRollbackTarget(db, round.taskId)` + `rollbackNodeRunWorktrees(target,
selfRun.rollback, {}, log)` 改为同一端口的 `load` + `scope.rollback(selfRun.rollback, log)`；仍在同一把 question 写信号量里、失败照旧
  只记 warn。
- bootstrap 的 `composeTaskExecutionParticipantBindings`（`bootstrap/crossContextClosure.ts`）与用例 helper
  `tests/helpers/taskExecutionParticipantBindings.ts` 交 task-execution 的 `createNodeRunWorkspaceRollback`；这一格必填，`tsc` 找出其余
  构造点（`rfc359-w55-clarify-execution-context` 的绑定字面量）。`architecture/rfc400-collaboration-task-participants` 的 owner 工厂表
  加上它（与其余装配输入同样不得经 task-execution public 漏出）。

### 1.3 public 收口

task-execution `public/queries` 的 `taskRollbackPlan` 迁移后模块外只剩用例取（用例本就从 `infrastructure/taskRollbackCodec` 取），撤出；
`hasTaskRollbackCheckpoint`（collaboration 在用）与 `TaskRollbackCheckpointRun`（collaboration 的端口在用）保留。

## 2. 资源限额（`services/limits.ts`）

- **`application/ports/taskResourceLimitAudit.ts`**（新）：`TaskResourceLimitCancellationAudit`（`taskId` / `reason` / `now`）与
  `TaskResourceLimitAudit.recordLimitCancellation(input)`，与 system-operations `application/ports/resourceLimitAudit.ts` 结构相同。
- **`application/resourceLimitEnforcement.ts`**（新）：`EnforceLimitsResult`、`ResourceLimitOperations`（`persistence:
TaskResourceLimitFacts & TaskResourceLimitAudit`，加 `cancelTask`）、`enforceLimits(operations)` 与私有的 `checkOne`，函数体逐字迁入；
  `callRowHumanWait` 取本模块定义处。原文件转出的 `readTaskResourceUsage` / `parseCallHumanWait` 不再转出。
- `composition.ts` 转出 `enforceLimits` 与 `ResourceLimitOperations`；`bootstrap/resourceLimits.ts`（类型）与 `bootstrap/daemonSession.ts`
  （定时调用）改从这里取。bootstrap 照旧把 `createResourceLimitAudit(db)` 展开进 `persistence`（结构上满足新端口）。
- public 收口：system-operations `public/operations` 的 `ResourceLimitAudit` 类型，task-execution `public/queries` 的 `callRowHumanWait`、
  `readTaskResourceUsage`、`parseCallHumanWait` 与 `public/types` 的 `TaskResourceLimitFacts`，模块外的生产消费方都只有这份策略
  （`services/limits.ts` 取用或转出），迁移后撤出（定义处不变），用例改取定义处。

## 3. agent 启动快照（`services/agentLaunch.ts`）

- **`domain/agentHostWorkflow.ts`**（新）：四个常量、`buildAgentHostSnapshot`、`validateAgentLaunchShape` 逐字迁入（纯函数，只取 shared 与
  `@/util/errors`）。
- task-execution 的 `infrastructure/taskRouteLaunchOperations.ts`、`infrastructure/executionOutcome.ts` 改取 `../domain/agentHostWorkflow`。
- `public/queries` 转出 `validateAgentLaunchShape`；integration 的 `composition/scheduledTasks.ts` 的类型 import 与惰性动态 import 都改指
  task-execution `public/queries`（保留原来的加载时机）。

## 4. 触发预检（`services/execution/triggerPreflight.ts`）

- **resource-catalog `domain/triggerPreflight.ts`**（新）：四个函数逐字迁入；`parseCallClosure` 改取本模块 `./callClosure`。
- resource-catalog `public/queries` 转出 `triggerSourceFromContext`、`triggerPreflightIssue`、`assertTriggerPreflight`
  （`collectLaunchTriggerDefinitions` 模块外无人取，不转出）。
- 消费方改取：task-execution 的 `composition/taskEngineApplication.ts`、`infrastructure/taskRouteLaunchOperations.ts`、
  `infrastructure/childExecutionLaunchOperations.ts`、`infrastructure/childTaskLifecycleParticipant.ts`、
  `infrastructure/frozenTaskTriggerPreflight.ts`、`infrastructure/taskRouteOperations.ts`，integration 的 `composition/webhookAdmission.ts`、
  `composition/scheduledTasks.ts`，与仍在 `services/` 的 `task.ts` → resource-catalog `public/queries`；resource-catalog 自己的
  `composition/workgroupTaskRoom.ts` → `../domain/triggerPreflight`。

## 5. 停用资源策略（`services/execution/resourcePolicy.ts`）

- **resource-catalog `domain/disabledResourcePolicy.ts`**（新）：`DisableableResourceKind`、`DisabledDisposition`、`DisabledPolicyEntry`、
  `PLUGIN_DISABLED_SITES`、`DISABLED_RESOURCE_POLICY`、`notModeledDisabledKinds` 逐字迁入，原文件对 `PLUGIN_DISABLED_ERROR_CODE` 的转出删除。
  插件禁用错误码的声明也从 resource-catalog `public/types.ts` 搬到这里（策略迁入后模块外再没有生产代码取它这个值，按 RFC-294 design
  §3.3 移回内部；`public/types` 的问题码联合仍按类型引用它），本模块的四个产出点改取这里，`rfc282-single-implementation-lock` 的 B3
  「这串字面量只出现在一处」改指新的声明处。
- resource-catalog `public/types` 转出 `DISABLED_RESOURCE_POLICY`、`notModeledDisabledKinds` 与类型 `DisableableResourceKind`
  （消费方：`services/runtime/selfCheck.ts`，随运行时驱动一族进 runtime-management 后照旧经 offered 边取）；`PLUGIN_DISABLED_SITES`
  只有用例取，不上 public。
- 消费方改取：resource-catalog 的 `infrastructure/legacy/workflow.validator.ts` → 本模块定义处；`services/runtime/selfCheck.ts` →
  resource-catalog `public/types`。注入 resource-catalog 的策略束 `services/execution/taskExecutionResourceDependencies.ts` 原来经
  `services/` 把这个错误码再交回 resource-catalog（`rfc349-execution-peripheral-provider` 锁它不取 resource-catalog）：错误码本就是
  resource-catalog 的，快照适配器 `infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts` 改取定义处，`pluginDisabledErrorCode`
  退出策略束与它的依赖接口（`rfc467-injection-oracle-relocation` 的外部策略清单同步），报出的错误码不变。

## 6. 用例、账本与清单

- **改取新位置**：回滚一族（`git-snapshot`、`rfc092-node-rollback`、`rfc098-snapshot-pin`、`single-nonroot-member-workspace`）、限额一族
  （`helpers/resourceLimits`、`rfc243-parent-child-lifecycle`、`rfc349-resource-limit-provider`）、启动快照一族（`builtin-workflow-auto-layout`、
  `rfc165-agent-launch`、`rfc199-workflow-revision`、`rfc218-agent-launch-ports`、`rfc359-w5hn-agent-launch-provider-parity`、
  `rfc365-automation-compatibility`）、触发预检一族（`rfc167-dynamic-workflow-engine`、`rfc223-pr3b-dynamic-token`、`rfc408-port-bindings`）、
  停用策略一族（`architecture/rfc317-registry-reverse-completeness`、`helpers/legacyTaskExecutionInjectionResolver`、
  `rfc282-a3-driver-selfcheck`、`rfc284-resource-policy-schema-guard`、`rfc470-workflow-facades-retirement`）；collaboration 端口的构造点
  （`helpers/taskExecutionParticipantBindings` 与 `tsc` 找出的其余处）。
- **源码文本守卫**按其锁的意图改指新文件：`rfc328-architecture-guards`（`rollbackNodeRunWorktrees` 的 effect 边界路径）、
  `scheduler-audit-s02` / `scheduler-audit-s13`（回滚源码）、`rfc349-resource-limit-provider` / `rfc349-sqlite-daemon-pausable-writers` /
  `rfc368-implementation-gate`（限额源码）、`rfc257-source-locks` / `rfc345-provider-neutral-classic-facades` / `source-text-rfc066-guards` /
  `rfc349-execution-peripheral-provider`（启动快照源码）、`rfc410-port-bindings`（绑定里的 import 行改指 resource-catalog public）、
  `architecture/rfc317-registry-reverse-completeness`（停用策略的声明文件）；逐个读守卫再改，不改它们的判据。`rfc257-source-locks` 的禁取
  清单删去已不存在、`tsc` 也编不过的 `@/services/agentLaunch`；`cross-clarify-designer-rerun-no-rollback` 锁「反问的跨节点与设计者重跑
  路径不回滚」，回滚入口改经端口后补一条同义的负锁（不许出现 `createNodeRunWorkspaceRollback`）。`architecture/rfc405-agent-single-executor`、
  `architecture/rfc410-dynamic-workflow-engine` 与 `rfc473-*` 只在自己判据的负对照样例里用到触发预检的旧路径（样例本身就是「取 legacy
  文件」或「同前缀的非退役文件」），原样保留，RFC-477 用例的路径扫描对这三个文件按名单豁免。
- **账本**：`architecture/commons-debt.json` 删 `nodeRollback` 的 3 条 `R1`、基线 30 → 27；`architecture/commons-manifest.json` 里指着
  这些文件的条目改指新位置（owner / layer 按新落位）；架构报告 owner 表删五个条目；`guard-manifest` 行数随登记守卫刷新；
  `architecture/counts.json` 收紧本 RFC 触及的减速带（C13）。
- **注释与文档链接**：e2e 与 shared / frontend 注释里指着这五个文件的源码位置改指新位置；`design/RFC-395-database-target-schema-rebuild/research.md`
  指向 `services/nodeRollback.ts` 的相对链接改指新位置（`design/` 的链接检查会报断链）。
- **新增 `tests/rfc477-rollback-limits-launch-preflight-owners.test.ts`**：五个文件不在、零 import / 路径字面量 / Markdown 链接（各带负对照）；
  `R1` 里没有它们（带负对照）；collaboration 不取 task-execution 的回滚内部、只经自有端口（带负对照），task-execution 不取
  system-operations（带负对照）；端口作用域的行为（`load` 为 null、`plan` 与 `rollback` 落到同一目标、带 `db` 的目标写 effect）；public
  的增减（新增符号都在、撤出的不在）；定义处（domain / application / infrastructure 各自的文件）。

## 7. 对 RFC-294 C10～C13 的对账

- **C10**：纯函数进 domain（启动快照、触发预检、停用策略、回滚结果说明），策略编排进 application（限额），git 与 effect 记账进
  infrastructure（回滚执行，RFC-328 的 act 现场；RFC-475 的经验：带 effect observer 的 act 现场不进 application）。没有新增「端口只有
  一个方法、实现即整个用例」的 infrastructure 文件，也没有往已承载用例的 infrastructure 文件里追加用例入口。
- **C11**：public 新增的是纯函数、常量与闭合类型，不是 SQL 片段、行形状的查询工厂或状态写原子；`public/operations` 只撤不增。
- **C12**：结构锁的覆盖范围写进 plan 的集中验证。
- **C13**：收口时把本 RFC 触及的减速带收紧到实测：`legacy-horizontal-files` max 173 → 168、`legacy-service-implementations` max 54 → 49
  （其余计数实测不变，不收紧；见 plan 的计数复核）。

## 8. 失败模式

- 漏改某个消费方或漏接端口 → `tsc` 报错（端口一格必填）；路径字面量与 Markdown 链接由 RFC-477 用例锁。
- collaboration 绕过端口直接取 task-execution 的回滚内部 → 跨 context 内部文件对与 RFC-477 用例报出。
- task-execution 取 system-operations 的审计类型 → off-DAG offered 文件对计数报出。
- 回滚作用域改用不带 `db` 的目标（`RollbackTarget.db` 是可选字段，`tsc` 不报）→ 在任务执行上下文里的回滚不再写 RFC-328 effect。
  评审只用作用域的 `plan`；反问自动派发的自回滚由答题路由触发时不在执行上下文里（与 HEAD 一样不记 effect），经任务续跑的收敛
  （gate continuation 的 pre-drive，`runWithTaskExecutionContext` 之内）进来时照旧记 effect——作用域与 HEAD 的直接调用是同一条路径。
  RFC-477 用例锁作用域经 `loadRollbackTarget(db, taskId)` 装载、规划与回滚都对着它（源码锁，带负对照），并在两个引擎上断言这个装载给出
  的目标带 `db`。

## 9. 测试策略

既有回滚、评审、反问自动派发、限额、启动、触发预检与停用资源用例照常覆盖行为；新增 RFC-477 用例锁结构与端口作用域。集中验证按
RFC-476 的做法：导出仓库里全量 SQLite、PostgreSQL lane、P0 变异 lane、四个包、计数复核与同一时刻的对照。
