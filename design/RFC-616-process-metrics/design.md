# RFC-616 技术设计：过程度量

> 状态：Done（2026-11-26），用户批准的设计门后修订稿；实现与本文不同的地方记在 plan.md §4.3。产品口径见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)，设计门的发现与处置见 plan.md §4.2。
> 取证基线：`6c92e2be2`。文中的 `path:line` 都是该提交上的位置；标“调研”的结论来自并行读码、我没有逐行复核，实现前须再核一遍（§15）。

## 1. 摘要

- 落在 `modules/run-observability`，沿用 RFC-371 v2 的做法：**统计按需聚合，不建派生表；跨模块只走端口**。
- 度量引擎只认一套统一模型（单元、阶段、执行聚合、人工门轮次、人的操作、调用）。三类能力的事实由拥有方模块按中立合同提供。
- 前三路感知读现有账本：节点执行记录、人工门的文档版本与反问轮次、运行观测的调用表。
- 第四路“人的操作”是唯一新增的写入：路由登记信息新增可选的 `observe` 声明，唯一登记点 `registerRoute` 统一记录，处理函数零改动。
- 新增两张表（人的操作、文本主题分析）、两个设置项、一个后台作业、六条 HTTP 路由、一个前端页签和六个公共组件。

## 2. 已核实的事实

| 事实 | 依据 |
| --- | --- |
| 任务与能力的关联：`task_definitions.subject_kind`、`source_id`、`source_revision`，索引 `(subject_kind, source_id)` | `packages/backend/src/modules/task-execution/infrastructure/persistence/schema.ts:1393-1443` |
| 工作流的名称没有冻结在任务上：`source_name` 只在主体为 Agent 时写入；任务列表用注入的名称表达式现查 | `task-execution/domain/taskCreation.ts:187`；`task-execution/infrastructure/taskListPage/page.ts:89-141` |
| 节点执行的身份与时间；`rerun_cause` 与 `role` 可为空 | 同上 schema `:2159-2203` |
| 全部重跑原因是一个闭集（30 项） | `packages/shared/src/schemas/task.ts:1079-1153` |
| 调度器铸新行时的原因只有三种：没有旧行为 `initial`；旧行是失败、中断、取消、触顶为 `revival`；其余为 `stale-redispatch` | `task-execution/application/resolveSchedulerRunRow.ts:62-76` |
| 人工重试先给目标节点和受连带的下游各铸一条**占位行**（状态为失败、从未启动，原因 `retry-node` 或 `retry-node-cascade`），真正的重跑随后由调度器按 `revival` 铸出；仓库准备的重试是例外，它的 `retry-node` 行就是那次执行 | `task-execution/infrastructure/taskRouteOperations.ts:2405-2461`；`task-execution/infrastructure/deferredRepositoryPreparation.ts:495-510` |
| 任务的引擎类型：普通任务 `dag`，工作组 `workgroup-turns`，动态工作流模式 `dw-generate` | `task-execution/domain/taskCreation.ts:190-195` |
| 完成确认的停驻行铸在 Leader 节点上，原因 `wg-gate`，带开门时的轮次；方案确认的驳回轮数记在运行状态里 | `task-execution/engine/task/workgroup/workgroupTurns.ts:2141-2153`；`packages/shared/src/dynamicWorkflow.ts:72` |
| 运行观测任务页的用量按任务 ID 取它的全部调用，不分用途 | `run-observability/application/observationQueries.ts:323-356` |
| 任务运行时长只在状态为运行中时累计；既有的“有效运行时长”会减去调用节点等待子任务等人的时间 | `task-execution/infrastructure/taskDefinitionWriteParticipant.ts:199-205`；`task-execution/application/taskResourceUsage.ts:30-45` |
| 评审：决定时把意见归档进 `comments_json` 并删除意见表里的行；作废版本的意见直接删除；兄弟评审被连带作废时写的是 `decision='rejected'`、`decided_by='system'` | `collaboration/infrastructure/review.ts:3483-3521,3655-3666`；`collaboration/infrastructure/humanGateOpenParticipant.ts:236-254` |
| 评审轮次的既有分组规则（只处理多文档）与按轮计时口径 | `collaboration/domain/reviewRounds.ts:76-150`；`task-execution/application/reviewRoundTiming.ts:1-77` |
| 反问：每轮一行，全部封存时写 `answered_at`、`answered_by`、`directive`；逐题作答人写在归属表 | `collaboration/infrastructure/clarifyAnswerWrite.ts:106-110,221-242` |
| 脑图问题的元数据：分类路径、父问题、追问请求号 | `packages/shared/src/schemas/clarifyMindmap.ts:40-51` |
| 调用记录带 `task_id`、`node_run_id`、`purpose`、`system_kind`；追问生成的调用 `node_run_id` 为空 | `run-observability/infrastructure/persistence/schema.ts:53-118`；`task-execution/composition/systemAgentObservations.ts:20-36` |
| 路由唯一登记点；HTTP 与 MCP 共用同一条门加处理函数链；MCP 不经过全局中间件 | `packages/backend/src/routes/registry.ts:246-292`；`platform/operations/boundOperationInvoker.ts:198-227` |
| 跨模块的 `public/*` 导入必须落在目标依赖图内，仅 identity-access 的类型导入有豁免；通向 run-observability 的边只有 task-execution | `packages/backend/tests/architecture/rfc294-review-offered-edge-dag.test.ts:219-253`；`tests/architecture/rfc294Target.ts:40-46` |
| run-observability 的导入白名单；`platform/` 下不许有路径含 `observ` 的文件 | `tests/architecture/rfc371-v2-observation-boundaries.test.ts:45-56,80-109` |
| 工作组完成确认的每次决定写成一条消息（作者、时间、结果、驳回意见） | `resource-catalog/infrastructure/workgroupTaskRoomCommands.ts:317-331` |
| 工作组派单只有创建和更新两个时间 | `task-execution/infrastructure/persistence/schema.ts:1003-1048` |
| 循环触顶时状态为 `exhausted`；开了“触顶后继续”的循环以 `done` 收场，只留一条诊断日志 | `task-execution/engine/wrapper/loopStrategy.ts:149-200,311-331` |
| 数字员工：交办是 `employee_cases`，每轮是 `employee_reaction_rounds`（没有按交办的普通索引），每次尝试启动一个内部宿主任务 | `digital-employee/infrastructure/persistence/schema.ts:290-340,899-956`；`task-execution/infrastructure/hostTaskLaunch.ts:121-167` |
| 交办的状态变化发布为事件中心的事件，主体为交办，路由事实带前后状态；事件表按主体有索引 | `digital-employee/application/lifecycleEvents.ts:22-56`；`event-center/infrastructure/persistence/schema.ts:196-222` |
| 终态种类的既有分类表（目录状态、是否失败、展示分桶） | `packages/shared/src/employeeTerminalKind.ts:54-80` |
| 阻塞原因在恢复和终止时清空 | `digital-employee/infrastructure/runtimeStore.ts:2166,2221` |
| 研发类型的职责图：两个区域、七条泳道 | `development-automation/application/employeeTypePackage.ts:2021-2150` |
| 可见性：任务为 owner 或协作成员，`tasks:read:all` 看全部；交办同形 | `task-execution/infrastructure/taskAuthorization.ts:125-167`；`digital-employee/application/caseAccess.ts:79-87` |
| 现有观测的范围判定与分块方式 | `run-observability/application/observationQueries.ts:215-250` |
| 系统 Agent 的运行通道 | `task-execution/application/ports/systemAgentRunFamily.ts:17-40` |
| 只读画布与职责图组件 | `packages/frontend/src/components/canvas/WorkflowCanvas.tsx:482`；`packages/frontend/src/components/digital-employees/EmployeeCapabilityPanorama.tsx:66-128` |

## 3. 架构落位（RFC-294）

### 3.1 所在的 bounded context 与分层

bounded context 是 `run-observability`（总纲 G2：运行时调用观测、用量与价格）。本 RFC 把它拥有的能力扩成“运行观测与过程度量”，新增代码按目标分层落位：

| 层 | 新增内容 |
| --- | --- |
| `domain/process/` | 统一模型的类型；时间拆分；分位数与排名分档；阶段与人工门的聚合；两段对比；提升点规则；文本主题的归类与计数。全部是纯函数 |
| `application/process/` | 用例：能力列表、能力汇总、单元分页、单元明细；人的操作的记录与读取；文本主题分析的受理、执行与读取；三类能力的装配器 |
| `application/process/ports/` | 本模块的端口：人的操作存储、分析存储、分析运行器、身份目录、工作流名称。事实端口的合同在 `platform/contracts/processFacts.ts`（见下） |
| `infrastructure/` | 两张新表的持久化（SQLite 与 PostgreSQL 同一份中立查询） |
| `inbound/http/` | `processRoutes.ts` |
| `composition/` | `processMetrics.ts`，只构造与注入，没有控制流 |
| `public/` | `participants.ts` 增加人的操作记录合同 |

### 3.2 跨模块的事实怎么取

目标依赖图里，通向 run-observability 的边只有 task-execution。collaboration、digital-employee、event-center 不能 import run-observability 的公开合同，哪怕只是类型（§2）。所以事实合同放在中立的位置，两边都只依赖它：

- **合同**：`packages/backend/src/platform/contracts/processFacts.ts`。只有类型：各事实行的形状，以及 `ProcessTaskFacts`、`ProcessWorkgroupFacts`、`ProcessGateFacts`、`ProcessEmployeeFacts`、`ProcessSubjectEvents` 五个接口。文件名不含 `observ`。
- **实现**：拥有方模块在自己的 `infrastructure/` 里实现接口，经自己的 `composition/processFacts.ts` 交出工厂函数（与 `task-execution/composition/taskObservationFacts.ts` 同形）。它们只 import 平台合同，不 import run-observability。
- **绑定**：`bootstrap/daemonHttpComposition.ts` 构造各实现，传给 `composeProcessMetrics`。
- run-observability 只 import 平台合同；它的导入白名单增加 `@/platform/contracts/processFacts` 一项。

| 接口 | 实现方 | 位置 |
| --- | --- | --- |
| `ProcessTaskFacts` | task-execution | `task-execution/infrastructure/processTaskFacts.ts` |
| `ProcessWorkgroupFacts` | task-execution | `task-execution/infrastructure/processWorkgroupFacts.ts` |
| `ProcessGateFacts` | collaboration | `collaboration/infrastructure/processGateFacts.ts` |
| `ProcessEmployeeFacts` | digital-employee | `digital-employee/infrastructure/processEmployeeFacts.ts` |
| `ProcessSubjectEvents` | event-center | `event-center/infrastructure/processSubjectEvents.ts` |

另外三个依赖用本模块自己的结构化端口，由装配根适配，不产生跨模块 import：身份目录（适配 identity-access 既有的 `OwnerIdentityQueries.loadOwnerIdentities`）、分析运行器（适配系统 Agent 运行通道）、工作流名称（适配任务列表已在用的名称表达式的同一来源）。

### 3.3 本 RFC 承担的演进与留下的债

- **演进**：工作组宿主执行到成员的归属规则今天写在 resource-catalog 的房间投影里（调研：`resource-catalog/application/workgroups/workgroupRoomProjection.ts:125-218`），而工作组执行属于 task-execution。两边互相 import 都不在目标依赖图里，所以把这条纯规则提到 `packages/shared/src/workgroupHostRun.ts`（shard 键的编解码已经在 `packages/shared/src/schemas/workgroup.ts:31-66`），房间投影与新的工作组事实实现都从 shared 取用，房间投影的输出逐字不变。规则从此只有一份。
- **留下的债**：工作组房间的查询与命令仍在 resource-catalog，不在本 RFC 范围。
- **不新增**：横向的 `routes/`、`services/` 文件，跨 context 的内部 import，装配根，全量账本，给其它模块的表加列或索引。

### 3.4 偏离项

没有需要用户确认的偏离。说明三点：

1. `routes/registry.ts` 位于存量的 `routes/` 目录，架构报告把它归为平台层。本 RFC 给 `RouteMeta` 加一个可选字段，记录器的类型与挂接函数也放在这个文件里，不新建平台文件；登记点不 import 任何模块。
2. run-observability 的导入白名单增加一项平台合同（§3.2）。这是它自己的边界用例，随本 RFC 一起改。
3. 结构版本只增加两个，各对应本模块的一张新表（§10.3）。

## 4. 统一模型

`modules/run-observability/domain/process/model.ts`：

```ts
export type ProcessSubjectKind = 'workflow' | 'workgroup' | 'digital-employee'
export type ProcessUnitStatus = 'succeeded' | 'failed' | 'canceled' | 'active'
export type ProcessOrigin =
  | 'manual' | 'scheduled' | 'event' | 'webhook' | 'api' | 'subtask' | 'digital-employee'

/** 一次运行：工作流或工作组的一个任务，或数字员工的一次交办。 */
export interface ProcessUnit {
  readonly id: string
  readonly subjectId: string | null
  readonly subjectName: string | null
  readonly subjectRevision: number | null
  readonly name: string
  readonly status: ProcessUnitStatus
  /** 原始状态或终态种类，用于展示与结局分桶。 */
  readonly outcome: string
  readonly origin: ProcessOrigin
  readonly ownerUserId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  /** 自动执行时长；null 表示这个单元没有运行时长记录（历史任务）。 */
  readonly autoMs: number | null
  /** 账本里的人工重试次数（人工重试的占位行数，见 §4.1）。 */
  readonly manualRetries: number
  /** 单元自己的任务。 */
  readonly ownTaskIds: readonly string[]
  /** 经调用节点派生出的子孙任务，以及它们挂在哪个调用节点上。 */
  readonly descendants: readonly { readonly taskId: string; readonly stageKey: string }[]
}

export type ProcessCause =
  | 'first' | 'review-rework' | 'clarify-rerun' | 'auto-retry'
  | 'cascade' | 'recovery' | 'system'

/** 一个单元里，某阶段、某执行原因的执行聚合。 */
export interface ProcessExecutionAggregate {
  readonly unitId: string
  readonly stageKey: string
  readonly cause: ProcessCause
  /** 工作组的轮次；其它能力为 null。 */
  readonly round: number | null
  readonly runs: number
  readonly endedRuns: number
  readonly failedRuns: number
  readonly interruptedRuns: number
  readonly activeMs: number
  readonly failureCodes: Readonly<Record<string, number>>
}

export interface ProcessStage {
  readonly key: string
  readonly label: string | { readonly 'zh-CN': string; readonly 'en-US': string }
  readonly kind: ProcessStageKind
  readonly parentKey: string | null
  readonly order: number
  readonly removed: boolean
}

export type ProcessGateKind =
  | 'review' | 'clarify' | 'completion' | 'delivery' | 'plan-confirm' | 'approval' | 'blocked'

/** 一次等人处理的区间。 */
export interface ProcessGateRound {
  readonly unitId: string
  readonly stageKey: string
  /** 反问的提问阶段；评审的被评审阶段。 */
  readonly relatedStageKey: string | null
  readonly kind: ProcessGateKind
  /** 人的操作按它关联：节点执行 ID、任务 ID 或交办 ID。 */
  readonly subject: { readonly kind: 'node-run' | 'task' | 'employee-case'; readonly id: string }
  /** 同一实例内有效轮次的序号（从 1 起）；作废的为 0。 */
  readonly ordinal: number
  /** 作废：只计入等人时间，不计入轮次、决定与意见的统计。 */
  readonly void: boolean
  readonly openedAt: number
  readonly closedAt: number | null
  readonly outcome: string | null
  readonly deciderUserId: string | null
  readonly measures: Readonly<Partial<Record<ProcessGateMeasure, number>>>
  readonly people: readonly { readonly userId: string; readonly comments: number; readonly answers: number }[]
}
```

`ProcessStageKind` 与 `ProcessGateMeasure` 都是闭集。

- 阶段类型：十四种节点类型各一项（`packages/shared/src/schemas/workflow.ts:38-59`，含 `clarify-cross-agent`、`code-host-call`、`code-round`）；`system`（平台合成的执行）；`unattributed`；工作组的 `leader`、`member-agent`、`member-human`；数字员工的 `work-item-tool`、`work-item-system`、`work-item-collaboration`（对应清单的 `nodeKind`）以及分组用的 `region`、`lane`。
- 人工门的数值：`comments`、`commenters`、`documents`、`documentsAccepted`、`questions`、`questionsInitial`、`questionsFollowup`、`followupRequests`、`depthSum`、`depthMax`、`answersRecommended`、`answersOther`、`answersCustom`、`answersSkipped`、`questionsWithRecommendation`、`maturityDecided`、`maturityProvisional`、`maturityUnmarked`、`categoriesConfigured`、`categoriesCovered`。

度量引擎的全部计算只读这几个类型，不出现按能力类型的分支；三类能力的差别只在“谁来产出这些值”和“阶段怎么分组”。

### 4.1 执行原因的归类

内部分七类，展示时把连带重跑与恢复续跑合成“其它重跑”，即 proposal §3 的六类。

`packages/shared/src/processCause.ts` 给出一张穷尽表，新增重跑原因而不归类时编译不通过：

```ts
export const PROCESS_CAUSE_OF = {
  initial: 'first', 'wrapper-init': 'first', 'fanout-shard': 'first', 'fanout-aggregator': 'first',
  'wg-leader-round': 'first', 'wg-assignment': 'first', 'wg-message-turn': 'first', 'dw-generate': 'first',
  'review-iterate': 'review-rework', 'review-reject': 'review-rework',
  'clarify-answer': 'clarify-rerun', 'cross-clarify-answer': 'clarify-rerun',
  'cross-clarify-questioner-rerun': 'clarify-rerun',
  'process-retry': 'auto-retry', 'wg-protocol-retry': 'auto-retry',
  'stale-redispatch': 'cascade',
  revival: 'recovery',
  'commit-push-session': 'system', 'merge-resolve': 'system',
  // 不是执行：人工重试的占位行、容器、停驻和虚拟行
  'retry-node': null, 'retry-node-cascade': null,
  'commit-push': null,
  'review-park': null, 'clarify-park': null, 'cross-clarify-park': null, 'io-virtual': null,
  'branch-skip': null, 'cross-clarify-guard': null, 'wg-gate': null, 'dw-gate': null,
} as const satisfies Record<RerunCause, ProcessCause | null>
```

补充四条规则：

1. **人工重试是占位行加一次恢复续跑。** 人工重试时，平台先给目标节点和受连带的下游各铸一条占位行（状态为失败、从未启动），真正的重跑随后由调度器铸出，原因是 `revival`（§2）。所以占位行归 `null`：把它算成执行会凭空多出一次“失败”。`revival` 归“恢复续跑”，它涵盖失败后的续跑、中断后的恢复、取消后的续跑和人工重试之后的重跑，账本上分不开这四种，展示上都属于“其它重跑”。**人工重试的次数**直接数 `retry-node` 占位行（每次人工重试恰好给目标节点铸一条；连带的下游是 `retry-node-cascade`，不重复计数）。唯一的例外是仓库准备：它的 `retry-node` 行就是那次重新执行，归“恢复续跑”，同时计一次人工重试。
2. **容器不重复计时。** 提交与推送的容器行与它的会话行在时间上重叠（调研：`task-execution/engine/node/commit-push/runCommitPush.ts:104-116`），容器行归 `null`，只计会话行。包装器的容器行（`role='container'`）同理，只在 `wrappers` 里表达。
3. **重跑原因为空**（历史行）归 `first`，并在页面的数据说明里注明。
4. **包装器换代。** 包装器在同一个帧里被重新执行时，内部行的重跑原因仍是 `initial` 或 `fanout-shard`（内部节点在新的包装器调用里没有旧行，§2）。所以内部行的 `first` 取它所在那次调用的原因：调用行自己写明了重跑原因（评审打回了包装器对外的产出、人对包装器“重试”后的续跑等）就用它；没有写明、但不是同一帧（任务、包装器节点、外层调用、外层轮次）里序号最小的那一次，记 `cascade`；嵌套在被重新调用的包装器里的首次调用沿用外层调用的原因。循环套循环时内层每个外层轮次各有一次首代，不受影响。包装器槽位上的 `retry-node` 占位行计一次人工重试，不算一次调用。（实现门后的修订，见 plan.md §4.3 第 16 至 18 条。）

归到 `null` 的行不计入执行次数、失败次数与时长；其中的停驻行由人工门一路表达。调用的原因另有一条规则：`purpose='system'` 的调用一律归 `system`，其余取它所属节点执行的原因。

## 5. 四路感知

### 5.1 节点执行（task-execution）

```ts
export interface ProcessViewer { readonly userId: string; readonly canReadAll: boolean }

export interface ProcessTaskFacts {
  /** 时间范围内可见的任务单元，创建时间倒序，最多 limit 个。subjectId 省略时取该类型的全部能力。 */
  units(viewer: ProcessViewer, query: {
    readonly kind: 'workflow' | 'workgroup'
    readonly subjectId?: string
    readonly from: number
    readonly to: number
    readonly limit: number
  }): Promise<readonly ProcessTaskUnitRow[]>
  /** 任意任务的概要（数字员工的宿主任务用）。ids ≤ 500。 */
  taskSummaries(taskIds: readonly string[]): Promise<readonly ProcessTaskSummaryRow[]>
  /** 经调用节点派生的子孙任务，以及各自挂在入参任务的哪个调用节点上。ids ≤ 500。 */
  descendants(taskIds: readonly string[]): Promise<readonly ProcessDescendantRow[]>
  /** 按任务、节点、重跑原因、所在包装器调用、工作组轮次聚合。ids ≤ 500。 */
  executions(taskIds: readonly string[]): Promise<readonly ProcessExecutionRow[]>
  /** 包装器一次调用一行：所在帧、序号、轮数、分片数、终态。ids ≤ 500。 */
  wrappers(taskIds: readonly string[]): Promise<readonly ProcessWrapperRow[]>
  /** 这些任务的叶子节点执行各落在哪个节点、什么原因、哪次包装器调用。ids ≤ 500。 */
  nodeRunIndex(taskIds: readonly string[]): Promise<readonly ProcessNodeRunRow[]>
  /** 冻结的工作流定义：阶段目录与画布用。 */
  definition(taskId: string): Promise<WorkflowDefinition | null>
  /** 数字员工：轮次到宿主任务。ids ≤ 500。 */
  reactionHostTasks(roundIds: readonly string[]): Promise<readonly { roundId: string; taskId: string }[]>
  /** 单个任务的全部执行区间，供明细页。 */
  spans(taskId: string): Promise<readonly ProcessSpanRow[]>
}
```

实现要点：

- `units`：`tasks` 联 `task_definitions`，条件为 `subject_kind`、可选的 `source_id`、`started_at` 落在范围内，再加既有的可见性条件 `taskVisibilityCondition`。不过滤 `catalog_visibility` 和 `parent_task_id`：数字员工调用工作流产生的内部任务和子任务都要计入。来源的推导：有 `digital_employee_round_id` 或 `digital_employee_case_id` 为 `digital-employee`；否则 `parent_task_id` 非空为 `subtask`；否则取 `task_launch_contexts.launch_origin`。
- 名称：工作组取 `workgroup_config_json` 里冻结的组名；工作流经注入的名称读取器现查，工作流已删除时为 null，页面显示“已删除的工作流”。
- 状态归类：`done` 为成功；`failed` 为失败；`canceled` 为取消；其余为进行中。任务概要同时带出 `error_summary`，引擎据此识别因超出时长或 Token 上限被取消的任务。
- `autoMs`：沿用既有的有效运行时长口径——`running_ms` 减去调用节点等待子任务等人的时间（`taskResourceUsage.ts:30-45` 的同一套账）。已结束而 `running_ms` 为 0 的任务没有运行时长记录，`autoMs` 为 null。
- `descendants`：沿 `parent_task_id` 逐层取子任务（走 `idx_tasks_list_parent_started_id`），层数以调用深度上限为界；每个子任务通过 `node_runs.child_task_id`（走 `idx_node_runs_child_task`）找到父任务里的调用节点；更深的后代沿用第一层祖先所挂的调用节点。
- `executions`：`node_runs` 按 `task_id IN (…)` 过滤，只取 `role` 不是 `container` 的行，`GROUP BY task_id, node_id, rerun_cause, container_run_id, wg_round`，取次数、已结束次数、失败次数、中断次数和 `SUM(finished_at - started_at)`（只累加两个时间都有的行）。返回的是**原始的重跑原因**，归类在引擎里做（§4.1），所以人工重试的占位行也在结果里，引擎用它数人工重试次数、不把它当执行。失败只认状态 `failed`；被评审取代而置为 `canceled` 的行不算失败。失败码另用一条 `GROUP BY task_id, node_id, failure_code` 的查询（同样排除占位行）。走索引 `idx_node_runs_task`。
- `wrappers`：`role='container'` 的行，一次包装器调用一行，带 `seq`、所在帧（`container_run_id`、`iteration`）、终态；轮数为以它为 `container_run_id` 的内部行的 `MAX(iteration) + 1`，分片数为内部行里不同 `shard_key` 的个数。走索引 `idx_node_runs_container`。
- `nodeRunIndex`：返回 `role` 不是 `container`、重跑原因不归 `null` 的行的 ID、任务、节点、重跑原因、所在包装器调用、工作组轮次与 `shard_key`。按任务分块取，不按节点执行 ID 分块。
- 评审节点自己的节点执行不在这一路表达：它的起止时间不代表单轮评审（`reviewRoundTiming.ts:3-18`）。
- 所有 `IN` 查询由调用方按 500 分块，接口对超过 500 的入参抛 `RangeError`，与 `taskObservationFacts.ts:20,77-80` 一致。

**阶段目录**由引擎从冻结的工作流定义推导：

- 节点为阶段，包装器为父阶段，父子关系用 `buildWorkflowScopeParentMap`（`packages/shared/src/workflowScope.ts:168`）。
- 执行聚合里出现而定义里没有的普通节点 ID 标为“已移除”。
- 平台合成的节点 ID 以双下划线开头，不在定义里，也不是“已移除”。它们归到固定的 `system` 阶段：提交与推送、合并冲突处理、仓库准备、编排器、其它系统工作。合成 ID 的前缀到阶段的对应写成一张表放在 `domain/process/` 里（前缀取值见 §15 第 1 项）。

**循环与扇出**：

- 每任务轮数：该包装器各次调用的轮数。
- 触顶：状态为 `exhausted`。开了“触顶后继续”的循环（定义里的 `continueOnMaxIterations`）以 `done` 收场，无法区分“恰好在最后一轮满足退出条件”与“触顶后继续”；这类循环把“轮数等于上限”也计入，页面上的名称是“触顶或跑满上限”。
- 分片失败：包装器状态为 `failed` 且有分片。

### 5.2 人工门（collaboration）

```ts
export interface ProcessGateFacts {
  /** 这些任务上的评审与反问轮次。ids ≤ 500。 */
  rounds(taskIds: readonly string[]): Promise<readonly ProcessTaskGateRoundRow[]>
  /** 文本主题分析的原文：评审意见与退回理由、反问的问题与回答。ids ≤ 500。 */
  texts(taskIds: readonly string[], sources: readonly ('review' | 'clarify')[]):
    Promise<readonly ProcessTextItem[]>
}
```

行的形状与 `ProcessGateRound` 相同，只是用 `taskId` 代替 `unitId`，由引擎换成单元。

**评审轮次**（`doc_versions`，走 `idx_doc_versions_task`）：

- 分轮：多文档用既有的 `groupDocVersionRounds`；单文档每个版本是一轮。
- **作废**：`decision='superseded'` 的版本，以及 `decided_by` 为系统的版本（兄弟评审被连带作废，§2）。作废的轮次 `void=true`：它的 `[created_at, decided_at]` 仍计入等人时间，但不计入轮次数、决定分布、首轮通过率和意见统计。
- **实例与序号**：同一个评审节点执行（`review_node_run_id`）是一个评审实例；迭代与退回后复用同一行，循环每轮另起一行。`ordinal` 是实例内按就绪时间排序的有效轮次序号。首轮通过率 = 第一个有效轮次的决定为通过的实例 ÷ 至少有一个已决定有效轮次的实例。“意见数随轮次的变化”按 `ordinal` 分组。
- `openedAt` 为本轮各版本 `created_at` 的最小值，`closedAt` 为 `decided_at`，`outcome` 为决定，`deciderUserId` 为 `decided_by`（系统值与历史值 `local` 取 null）。
- `subject` 为评审节点执行，`stageKey` 为评审节点，`relatedStageKey` 为被评审的节点（`source_node_id`）。
- 数值：`comments`、`commenters` 从已决定版本的 `comments_json`、未决定版本的意见表计算；`documents`、`documentsAccepted` 来自 `selection`。`people` 按意见作者汇总。

**反问轮次**（`clarify_rounds`，走 `idx_clarify_rounds_task`）：

- `openedAt` 为 `created_at`；`closedAt` 为 `answered_at`。
- 取消与放弃的轮次 `void=true`，`outcome` 为状态值；`closedAt` 对放弃取 `abandoned_at`，对取消取中介节点执行的 `finished_at`（collaboration 已经通过参与方绑定读节点执行）；两者都取不到时等于 `openedAt`，不让一个没有结束时间的区间一直延伸到单元结束。
- `outcome` 为 `continue` 或 `stop`；`deciderUserId` 为 `answered_by`。
- `subject` 为中介节点执行，`stageKey` 为中介节点（画布上的反问节点），`relatedStageKey` 为提问节点。工作组的中介节点是 `__wg_clarify__`，提问方由 `asking_shard_key` 区分，由引擎用工作组事实换成成员。
- 问题来自 `questions_json`；回答经既有的 `readClarifyAnswerProjection` 读取（它兼容历史上存在 `legacy_answers_json` 里的回答，调研：`collaboration/infrastructure/clarifyAnswerQueries.ts:103-112`）。只存在于历史处置归档里的更早轮次不计入（proposal §12）。
- 数值：问题数、初始与追问生成的问题数（有无 `mindmap.requestId`）、追问次数（不同 `requestId` 的个数）、深度之和与最大值（按 `parentQuestionId` 链迭代计算）、四类回答方式、有推荐项的问题数、成熟度分布。预设分类的两个数值需要节点配置，由引擎用冻结定义里的 `mindmap.categories` 补上。
- 回答方式的判定（每题一类）：跳过状态生效（`clarifySkipStatus`，`packages/shared/src/clarifyMindmap.ts:70-77`）为跳过；有非空自定义文本为自己写；选中的选项全部带 `recommended` 为采纳推荐项；其余为选了其它选项。
- `people` 按逐题归属的 `userId` 汇总回答数。

`comments_json` 与 `questions_json` 的解析在 collaboration 内部完成，`rounds` 只返回数值；原文只经 `texts` 取，且只在文本主题分析时调用。

### 5.3 调用（本模块）

`CallStore` 增加三个只读方法：

```ts
/** 这些任务的调用按节点执行汇总；system 调用另按 system_kind 汇总。带“用量为下限”“未定价”的调用数。ids ≤ 500。 */
usageByNodeRun(taskIds: readonly string[]): Promise<readonly NodeRunUsage[]>
/** 某类 system 调用在这些任务上的逐条记录（追问生成按时间归到脑图轮次用）。ids ≤ 500。 */
systemCalls(taskIds: readonly string[], kind: string): Promise<readonly SystemCallSlice[]>
/** 最早一条调用记录的开始时间；没有任何记录时为 null。 */
usageSince(): Promise<number | null>
```

- **口径与既有页面一致**：单元的 Token 与成本 = 它名下任务（含子孙任务）的全部调用，不分用途；这与运行观测任务页的“任务全程用量”相同（`observationQueries.ts:324-355`），所以没有子任务的任务在两处数字相等。记忆提取、变更叙述这类事后的平台工作因此也在内，归“系统工作”。
- **两个标记原样带出**：有用量不完整的调用时标“用量为下限”，有未定价的调用时标“含未定价”，与既有页面的做法一致（`packages/shared/src/schemas/observation.ts:66,77-78`）。
- **Token 类指标的样本**：只取已结束、且开始时间不早于 `usageSince()` 的单元。更早的单元没有调用记录，计入会把均值拉低；被排除的单元数在响应里给出，页面注明。
- 调用到阶段与原因：引擎把 `usageByNodeRun` 的结果与 `nodeRunIndex` 在内存里按节点执行 ID 合并。子孙任务的调用归到它们所挂的调用节点。找不到对应节点执行的调用计入单元合计，归“未归属”。
- 追问生成的调用没有 `node_run_id`，按任务和时间归属：开始时间落在某个脑图轮次的 `[openedAt, closedAt]` 内即归该轮。

### 5.4 人的操作（新增）

**声明。** `RouteMeta` 增加可选字段：

```ts
export interface RouteObservation {
  /** 闭集，见下表。 */
  readonly action: ProcessOperationAction
  /** 对象从哪个路径参数取。 */
  readonly subject: { readonly kind: 'task' | 'node-run' | 'employee-case'; readonly param: string }
  /** 'session'：30 分钟内的重复并入同一条。'each'：每次一条。 */
  readonly mode: 'session' | 'each'
}
```

- 字段写在 `path` 之后：`tests/api-contract-coverage.test.ts:44,202` 用正则发现路由，`path:` 之前出现 `}` 会破坏发现（调研）。
- `sameMeta`（`registry.ts:137-146`）加入对 `observe` 的**逐字段**比较：每次建 app 传入的都是新对象，不能比较引用。
- 字段名和子字段名都不用 `identity`（`tests/rfc305-architecture-lock.test.ts:587`）。
- 不从请求体取值：需要“决定是通过还是驳回”的两处（工作组的完成确认、方案确认）在账本里已有结果（§6.2），不需要读请求体。

**登记点。** `registry.ts` 里新增记录器的类型与挂接函数，`registerRoute` 在 `gate` 外再包一层，HTTP 与 MCP 都经过它：

```ts
export interface RouteOperationSink {
  record(input: {
    readonly observation: RouteObservation
    readonly subjectId: string
    readonly actorUserId: string
    readonly transport: 'http' | 'mcp'
    readonly at: number
  }): Promise<void>
}
export function attachRouteOperationSink(app: object, sink: RouteOperationSink): void

const observed: MiddlewareHandler = async (c, next) => {
  const spec = meta.observe
  const sink = spec === undefined ? undefined : routeOperationSinkOf(app)
  if (spec === undefined || sink === undefined) return gate(c, next)
  await gate(c, next) // 抛错（MCP）则直接向上，不记录
  if (c.error !== undefined || c.res.status >= 400) return
  const actor = tryActorOf(c)
  const subjectId = c.req.param(spec.subject.param)
  if (actor === null || actor.source === 'daemon' || subjectId === undefined) return
  await sink.record({ … }).catch((error) => log.warn('route operation not recorded', { … }))
}
```

- HTTP 上 Hono 逐步捕获异常，`next()` 正常返回并带错误响应；MCP 上异常直接传出（`boundOperationInvoker.ts:157-176`）。两种情况都不会记录失败的操作。
- 挂接函数与 `attachExecutionAvailability` 同形（`platform/http/executionAvailability.ts:19-32`）；`mountApiRoutes` 在挂载路由之前绑定。没有绑定记录器的 app（测试、工具入口）不记录。
- 记录器由 run-observability 实现（`public/participants.ts` 的 `OperationObservations`，它只从 `@/routes/registry` 取类型，在白名单内），装配根注入；注入时带上数据库写窗口的读取器，窗口未开时不写，与令牌审计的做法一致（调研：`packages/backend/src/server.ts:747-762`）。
- 记录在处理函数成功之后、响应返回之前写入，是一次单行写；失败由登记点记一条告警并吞掉，不影响原操作。登记点为此新增一个日志器（`createLogger`，`@/platform/logging/logger`，与 `packages/backend/src/server.ts:731` 同一做法）；run-observability 的导入白名单里没有日志模块，所以日志留在登记点。
- 传输方式取 `c.get('operationTransport')`，没有即 `http`。
- 记录的含义是“这个调用成功返回了”。有些成功的调用并没有改变状态（对已终态的交办再次终止、用同一个请求号重放追问）。所以凡是账本里有的计数（追问次数、人工重试次数、决定次数）一律以账本为准，人的操作只用来补“谁、何时”。

**合并规则（`session` 模式）。** 记录器先查同一动作、对象、操作人的最近一条：存在且距今不超过 30 分钟，则只更新 `last_at`（且仅当距上次更新已满 60 秒）；否则插入新行。进程内用一个 4,096 项的最近写入表跳过 60 秒内的重复查询；它只是减少读写的手段，多实例部署下各自维护，最多多写几次，不影响结果。评审详情页每 8 秒轮询一次（调研：`packages/frontend/src/routes/reviews.detail.tsx:96`），按上述规则每个打开着的页面每分钟最多一次更新。

**第一版声明为可观测的操作**（19 条路由经设计门逐条核对存在，方法、路径、参数名与所指对象一致）：

| 动作 | 路由 | 对象 | 模式 |
| --- | --- | --- | --- |
| `review.view` | GET `/api/reviews/:nodeRunId` | 节点执行 | session |
| `review.comment` | POST `/api/reviews/:nodeRunId/comments` | 节点执行 | each |
| `clarify.view` | GET `/api/clarify/:nodeRunId` | 节点执行 | session |
| `clarify.followup` | POST `/api/clarify/:nodeRunId/followup` | 节点执行 | each |
| `task.cancel` | POST `/api/tasks/:id/cancel` | 任务 | each |
| `task.resume` | POST `/api/tasks/:id/resume` | 任务 | each |
| `task.retry-node` | POST `/api/tasks/:id/nodes/:nodeRunId/retry` | 任务 | each |
| `task.repair` | POST `/api/tasks/:id/alerts/:alertId/repair` | 任务 | each |
| `task.sync-workflow` | POST `/api/tasks/:id/sync-workflow` | 任务 | each |
| `question.dispatch` | POST `/api/tasks/:id/questions/dispatch` | 任务 | each |
| `question.manual` | POST `/api/tasks/:id/questions/manual` | 任务 | each |
| `workgroup.message` | POST `/api/workgroup-tasks/:taskId/messages` | 任务 | each |
| `workgroup.deliver` | POST `/api/workgroup-tasks/:taskId/assignments/:id/deliver` | 任务 | each |
| `workgroup.confirm` | POST `/api/workgroup-tasks/:taskId/confirm` | 任务 | each |
| `workgroup.plan-confirm` | POST `/api/workgroup-tasks/:taskId/dw-confirm` | 任务 | each |
| `workgroup.cancel-assignment` | POST `/api/workgroup-tasks/:taskId/assignments/:id/cancel` | 任务 | each |
| `workgroup.config` | PUT `/api/workgroup-tasks/:taskId/config` | 任务 | each |
| `employee-case.resume` | POST `/api/employee-cases/:id/resume` | 交办 | each |
| `employee-case.terminate` | POST `/api/employee-cases/:id/terminate` | 交办 | each |

路由位置：`collaboration/inbound/http/reviewRoutes.ts:213,398`、`clarifyRoutes.ts:120,229`、`taskQuestionRoutes.ts:112,225`、`task-execution/inbound/http/taskRoutes.ts:389,540,583,631,665`、`resource-catalog/inbound/http/workgroupTaskRoutes.ts:137,175,195,215,234,252`、`digital-employee/inbound/http/digitalEmployeeRoutes.ts:523,540`。每条路由的改动只是在登记信息里加一个 `observe` 对象。

评审决定、反问提交不在表里：它们的操作人和时间已经在人工门一路的账本里。

**读取。** 引擎按对象读取：`OperationStore.bySubjects(kind, ids, actions)`，ids ≤ 500，走索引 `(subject_kind, subject_id, action, last_at)`。用途：

- 响应等待与处理用时：对一个评审或反问轮次，取同一节点执行上 `review.view` / `clarify.view` 的各条会话，找出与 `[openedAt, closedAt]` 相交的最早一条；首次打开时间为 `max(first_at, openedAt)`。没有相交的会话时两项都为空。
- 追问的时间与发起人：`clarify.followup`。
- 人工重试、续跑、取消、修复、同步工作流的操作人；数字员工恢复与终止的次数和操作人。

## 6. 三类能力的装配

`application/process/kinds/` 下三个装配器把事实拼成统一模型。它们是本模块的用例代码，不含 SQL。

### 6.1 工作流

1. `ProcessTaskFacts.units({ kind: 'workflow', … })` 取单元；`descendants` 取各单元的子孙任务。
2. 对单元自己的任务分块取 `executions`、`wrappers`、`nodeRunIndex`；对单元自己的任务与子孙任务一起取人工门轮次、调用用量、人的操作。
3. 阶段目录取时间范围内最近一个单元的冻结定义；其它单元里多出来的普通节点追加为“已移除”。画布也用这份定义。
4. 调用节点：时长是它自己的节点执行时长；Token 是挂在它下面的子孙任务的调用合计；子孙任务上的人工门轮次计入本单元的等人时间，`stageKey` 记为这个调用节点。子孙任务内部各节点的拆分不在父单元里展开，它们在被调用工作流自己的度量里看（来源为 `subtask`）。

### 6.2 工作组

```ts
export interface ProcessWorkgroupFacts {
  /** 成员名单与模式、轮数上限（启动时冻结并可中途修改的运行配置）。ids ≤ 500。 */
  rosters(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupRosterRow[]>
  /** 派单聚合：按任务、轮次、来源、接单成员、终态。ids ≤ 500。 */
  assignments(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupAssignmentRow[]>
  /** 派给人类成员的派单：创建时间、交付消息的时间与作者、取消时的更新时间。ids ≤ 500。 */
  deliveries(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupDeliveryRow[]>
  /** 完成确认与方案确认的停驻行：起止时间、开门时的轮次。ids ≤ 500。 */
  gateRuns(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupGateRunRow[]>
  /** 完成确认的每次决定：作者、时间、结果。ids ≤ 500。 */
  gateDecisions(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupGateDecisionRow[]>
  /** 人发的消息数、配置修订数、暂停原因、方案驳回轮数。ids ≤ 500。 */
  activity(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupActivityRow[]>
  /** 文本主题分析：人发的消息与完成确认的驳回意见。ids ≤ 500。 */
  texts(taskIds: readonly string[]): Promise<readonly ProcessTextItem[]>
}
```

- **阶段**：`leader`，以及每个成员一个 `member:<成员 ID>`。宿主执行来自 `ProcessTaskFacts.nodeRunIndex` 与 `executions`（它们已经带 `shard_key` 与 `wg_round`），归属用 shared 里的那一份规则（§3.3），与房间投影完全一致：
  - 节点为 `__wg_leader__` 的归 Leader；
  - `shard_key` 为 `msg:<成员>:…` 或 `batch:<成员>:…` 的，成员从键里解析；
  - `shard_key` 等于某张派单 ID 的，按该执行的 `agent_override_id` 找**唯一**使用这个 Agent 的成员；有多个成员共用同一个 Agent 时归不出来。既有规则刻意不用派单上的接单成员，因为它可以被改派。
  - 归不出来的进“未归属”阶段，在页面上单列，不丢弃。
- **按轮次**（Leader 派单模式）：第 k 轮的派单数来自 `assignments`；耗时为该轮 Leader 执行开始到该轮全部成员执行结束；Token 为该轮各执行的调用合计。自由协作没有 Leader 轮次，改给预算使用：已用为成员执行次数，上限为运行配置里的轮数上限。
- **人工门**：
  - `delivery`：派给人类成员的派单。`openedAt` 为派单创建时间；已交付的 `closedAt` 为交付消息时间、决定人为交付消息的作者；被取消的 `void=true`、`closedAt` 取派单的更新时间。
  - `completion`：每个 `wg-gate` 停驻行一个区间。停驻行铸在 Leader 节点上（§2），它归 `null`，不会被算成 Leader 的执行。结果、决定人与时间取 `gateDecisions`：完成确认的每次决定都写成一条人发的系统消息，正文以固定前缀标明通过或驳回（§2）；按时间与停驻行配对。驳回意见也在这条消息里，供文本主题分析用。“每次驳回后多跑的轮数”是相邻两个停驻行的轮次之差。
  - `plan-confirm`：每个 `dw-gate` 停驻行一个区间；驳回轮数取运行状态里记录的值，最后一次为通过（任务进入执行阶段时）。
  - `clarify`：来自 collaboration，`relatedStageKey` 按 `asking_shard_key` 换成成员。
- **人发的消息数**：作者为人、种类为聊天或派单的消息。确认、交付、改配置产生的消息不算。
- **协调开销**：`leader` 阶段的 Token ÷ 单元全部 Token。**协议重试率**：重跑原因为 `wg-protocol-retry` 的执行 ÷ 全部执行。
- **触顶**：`workgroup_task_state.pause_reason` 为 `max-rounds-wrapup`，或任务失败且错误为轮数触顶。
- Leader 空转这类没有人工门的暂停，时间落在“排队与中断”。
- **动态工作流模式**（`engine_kind='dw-generate'`）：方案通过后节点执行按普通节点聚合。各任务的节点互不相同，生成的图里只有 Agent 节点（调研：`packages/shared/src/dynamicWorkflow.ts:288-296`），所以汇总页按每个任务冻结定义里节点的 `agentId` 聚合到成员；单元明细里按该任务冻结的定义列出节点。

### 6.3 数字员工

```ts
export interface ProcessEmployeeFacts {
  /** 时间范围内可见的交办，创建时间倒序。 */
  cases(viewer: ProcessViewer, query: { employeeId?: string; from: number; to: number; limit: number }):
    Promise<readonly ProcessEmployeeCaseRow[]>
  /** 各轮：工作项、状态、尝试序号、创建与结算时间。ids ≤ 500。 */
  rounds(caseIds: readonly string[]): Promise<readonly ProcessEmployeeRoundRow[]>
  /** 计量回执：每次已结算尝试的时长与 Token。ids ≤ 500。 */
  metering(caseIds: readonly string[]): Promise<readonly ProcessEmployeeMeteringRow[]>
  /** 把生命周期事件解释成状态变化序列（阻塞区间用）。纯函数。 */
  transitions(events: readonly ProcessSubjectEventRow[]): readonly ProcessEmployeeTransitionRow[]
  /** 外部审批：提交与观察到终态的时间。ids ≤ 500。 */
  approvals(caseIds: readonly string[]): Promise<readonly ProcessEmployeeApprovalRow[]>
  /** 人提的反馈条数（经类型包的投影方法；研发类型为 MR 上的检视意见）。ids ≤ 500。 */
  humanFeedbackCounts(caseIds: readonly string[]): Promise<readonly ProcessEmployeeFeedbackCountRow[]>
  /** 职责图：区域、泳道、工作项及其名称与顺序；以及类型声明的返工类工作项。 */
  manifest(typeId: string, typeRevision: number): Promise<ProcessEmployeeManifest | null>
  /** 文本主题分析：人提的反馈原文（同上）。ids ≤ 500。 */
  texts(caseIds: readonly string[]): Promise<readonly ProcessTextItem[]>
}

export interface ProcessSubjectEvents {
  /** 某类主体的事件历史：主体引用、发生时间、路由事实。refs ≤ 500。 */
  history(subjectType: string, subjectRefs: readonly string[]): Promise<readonly ProcessSubjectEventRow[]>
}
```

- **读取路径**：交办按 `(employee_id, …)` 的既有索引；计量回执按 `(case_id, created_at)`；外部审批与 Context 按交办的既有索引。轮次按 `case_id IN (…)` 读取，这张表没有按交办的普通索引（§2）。协作类的轮次和没启动就失败的轮次不写计量回执，所以不能用回执反推轮次全集，必须直接读轮次表。集中验证时用 2,000 次交办、每次 20 轮的夹具实测这条查询；超出预算就在本 RFC 内给轮次表补一个 `(case_id)` 索引（多一个结构版本），结果记在 plan。
- **状态变化序列**：交办的每次状态变化都发布为事件中心的事件（§2）。`ProcessSubjectEvents.history('digital-employee.case', 交办 ID)` 由事件中心实现，走 `(subject_type, subject_ref, occurred_at)` 索引；状态词汇的解释留在数字员工模块的 `transitions` 里。
- **单元**：一次交办。`subjectId` 为 `employee_id`，`subjectName` 为员工定义的名称，`subjectRevision` 为 `employee_revision`。状态用既有的分类表（§2）：不算失败的终态种类为成功（已合入、无需修改、普通完成）；算失败且目录状态为取消的为取消（关闭未合入、取消）；其余算失败的为失败；非终态为进行中。结局分桶直接用分类表的展示分桶。可见性沿用 `canViewCase` 的判据，`canReadAll` 取 `tasks:read:all`。
- **任务**：各轮的宿主任务，经 `ProcessTaskFacts.reactionHostTasks` 取（走 `idx_task_launch_contexts_digital_employee_round`）；它们是单元自己的任务。
- **阶段**：职责图的区域、泳道、工作项，来自类型包清单（调研：`digital-employee/domain/model.ts:249-345`）；名称是中英双语的字面值，原样返回，由前端按界面语言选择。
- **执行聚合**：每轮一条，`stageKey` 为 `work_item_ref`，时长为 `settled_at − created_at`，失败认状态 `failed`。尝试序号大于 0 的部分记为失败重试：一轮记 1 次首次执行加 `attempt_ordinal` 次失败重试，时长全部记在首次执行上。
- **Token**：宿主任务的调用合计归到它所属轮次的工作项。
- **`autoMs`**：计量回执的 `duration_ms` 之和（它本身就是有效运行时长）。
- **人工门**：
  - `review`：宿主任务里评审节点（合成宿主里的方案审核节点）的轮次，来自 collaboration；`stageKey` 换成它所在轮次的工作项。
  - `approval`：每个外部审批一个区间，提交时间到观察到终态的时间。
  - `blocked`：状态变化序列里每次进入阻塞到离开阻塞。阻塞原因取交办当前的 `block_reason`；它在恢复和终止时清空（§2），所以只有当前仍在阻塞的交办有原因，原因分布只统计这些交办。
- **交付周期的分界**只用清单的结构来判定：按 `order` 排在第一位的职责区域里，主干泳道（`kind='spine'`）的最后一个工作项首次结算成功的时间。研发类型里这是“提交 MR”结算的时间。交办到分界、分界到终态各算一段。
- **类型自己声明的两件事**。通用的数字员工模块不解析类型私有的内容，沿用既有的“类型提供方解释自己的东西”的做法（`digital-employee/public/types.ts:20-60,88-94`），给类型包加两个可选成员：
  - 登记项上的 `describeProcessMetricsJson?()`：返回这类员工的**返工类工作项**的引用列表。研发类型声明修复检视问题、修复流水线、修复冲突三项。
  - Context 编解码器上的 `projectHumanFeedbackJson?(contextTypeId, stateJson)`：返回这份 Context 里人提的反馈条目（正文、时间、可选的工作项引用）。研发类型实现它，取 MR 上作者为人的检视意见（调研：`employeeTypePackage.ts:3225-3277`）。
  - 数字员工模块调用这两个方法并校验返回值。没有实现的类型，对应的指标为空、页面显示“不适用”。
- **一次通过**：已合入的交办里，返工类工作项的轮数都为 0，且没有阻塞区间。类型没有声明返工类工作项时不计算。
- 数字员工把工作流当工具时，宿主任务的 `subject_kind` 是 `workflow`，同时会出现在 §6.1 的单元里，来源为 `digital-employee`。两边各自统计，不互相扣减。

## 7. 度量引擎

全部在 `domain/process/`，输入统一模型，输出汇总；不访问数据库。

| 文件 | 职责 |
| --- | --- |
| `stats.ts` | 中位数、P90、均值、比率（分母为 0 时为 null）；按排名分五档 |
| `timeline.ts` | 时间拆分 |
| `causes.ts` | 原始重跑原因到内部七类的归类、占位行与仓库准备的例外、包装器换代的改判（§4.1）；内部七类到展示六类 |
| `stages.ts` | 阶段目录：定义里的节点、已移除的节点、平台合成的节点 |
| `unitSummary.ts` | 每单元的汇总：时间拆分、按原因的 Token 与时长占比、人工介入次数、是否一次通过 |
| `stageSummary.ts` | 每阶段跨单元的聚合 |
| `gateSummary.ts` | 每类人工门的聚合、按人聚合、按序号的意见数、响应等待 |
| `trend.ts` | 按周分桶（沿用现有按固定偏移分桶的做法） |
| `compare.ts` | 两组汇总之间的变化与变好变差的方向 |
| `hints.ts` | 规则求值 |
| `themes.ts` | 文本主题：由归类结果算条数、占比、摘录 |

**时间拆分。** 对一个已结束、有运行时长记录的单元：

```text
lead   = endedAt − startedAt
wait   = 人工门区间并集的长度（含作废的轮次；每个区间先裁剪到 [startedAt, endedAt]）
auto   = min(autoMs, lead)
waitEx = min(wait, lead − auto)
other  = lead − auto − waitEx
```

- 三项之和恒等于 `lead`。按门的种类拆分 `waitEx`：先各自求并集长度，再按比例缩放到合计等于 `waitEx`。
- 这是一个近似：只在“自动执行加等人超过总历时”时才从等人里扣掉重叠，等于假设两者尽量不重叠。并行分支上同时有人工门和别的节点在跑、中间又有中断时，等人会被高估、“排队与中断”被低估。逐时刻的精确划分需要任务状态的完整时间线，不在第一版范围；proposal §12 已写明。
- 没有运行时长记录的单元（`autoMs` 为 null）不进时间拆分的统计，单列计数。

**按原因的拆分。** Token 按原因的各项相加等于单元的 Token 总量。时长按原因的拆分用的是节点执行时长之和：并行的节点会同时计时，它不等于 `autoMs`。所以时长只给各原因在节点执行时长合计里的**占比**，不给绝对值相加的断言。

**排名分档。** 取适用该指标的全部不同数值排序，第 i 个（从 0 起）的档位为 `1 + round(4 × i ÷ (n − 1))`；只有一个不同数值时为第 3 档；不适用的为 0。

**一次通过。** 工作流与工作组：成功完成的单元里，同时满足四条——没有评审返工的执行、没有自动重试的执行、没有失败的执行、没有人工重试。用“有没有失败的执行”而不用“有没有恢复续跑”来判定，是因为恢复续跑在账本上分不出起因（§4.1）：失败后续跑的单元一定有一次失败的执行，会被这一条拦住；守护进程重启造成的中断和人主动取消后的续跑没有失败的执行，不影响一次通过。上游变化连带的重跑和反问后的续跑也不影响。数字员工见 §6.3。

**人工介入次数。** 每单元三项相加：已关闭的有效人工门轮次数（账本）；人工重试次数（账本，§4.1）；人的操作里的续跑、修复、同步工作流、取消（只有上线后的）。

**稳定性。** 中断次数为状态是中断的执行数；恢复续跑次数为 `recovery` 类的执行数；自动重试次数为 `auto-retry` 类的执行数；人工重试次数取账本；因超限被取消的单元数来自任务概要里的错误摘要；续跑与修复操作的次数取人的操作。

**提示规则。** 规则标识是闭集，放在 `packages/shared/src/schemas/processMetrics.ts`，与汇总响应同一份 zod 定义；阈值是 `hints.ts` 里的一组常量。每条规则是一个 `(summary) => { 参数 } | null` 的纯函数，用 `satisfies Record<ProcessHintId, …>` 保证穷尽。前端按 `processMetrics.hint.<id>` 取文案并代入参数。规则与阈值见 proposal §8。

## 8. 查询接口

### 8.1 路由

全部在 `inbound/http/processRoutes.ts`，门为 `tasks:read`、`tokenAccess: 'allow'`，与现有观测路由相同；范围在处理函数里按账号的范围点判定。

| 路由 | 返回 |
| --- | --- |
| `GET /api/observability/process/subjects?kind&from&to` | 能力列表：每个能力的关键指标 |
| `GET /api/observability/process/subjects/:kind/:subjectId?from&to&tz&compare&split&origin` | 能力汇总：指标卡、时间与原因拆分、趋势、阶段、人工门、按人（有权限时）、提示、稳定性、阶段目录与画布定义 |
| `GET /api/observability/process/subjects/:kind/:subjectId/units?from&to&status&origin&cursor` | 单元分页，每页 25 |
| `GET /api/observability/process/units/:kind/:unitId` | 单元明细：各阶段与各轮人工门 |
| `GET /api/observability/process/subjects/:kind/:subjectId/insight?from&to` | 当前查看者范围内最近一次文本主题分析与状态 |
| `POST /api/observability/process/subjects/:kind/:subjectId/insight` | 受理一次分析，返回 202 |

`:subjectId` 对没有来源 ID 的单元用保留值 `-`。查询参数与响应都用 `packages/shared/src/schemas/processMetrics.ts` 里的 zod 定义，时间范围上限沿用 366 天。

### 8.2 范围与上限

- `viewer = { userId, canReadAll: permissions.has('tasks:read:all') }`；没有 `tasks:read:own` 也没有 `tasks:read:all` 的账号得到空结果。
- 按人的明细（人工门的 `people` 汇总、工作组人类成员的个人行）只在 `canReadAll` 时返回；否则响应里对应字段为 null，前端显示说明。
- 能力汇总最多 2,000 个单元，能力列表最多 5,000 个单元；多取一个用于判断是否超出，超出时响应带 `partial: true`。
- 能力列表只用便宜的事实：单元概要、按任务的调用合计、执行聚合（一次通过率）、人工门区间（等人占比与介入次数）。它不取节点执行索引、不解析意见与问题的 JSON、不求提示。所以列表不显示“提示数”。
- 响应里的用户只给 ID，另附一份由身份目录批量取回的身份表（ID、用户名、显示名），与任务列表的做法一致（调研：`task-execution/infrastructure/taskListPage/projection.ts:185`）。
- 每个响应都带数据说明字段：统计的单元数、因没有调用记录而未进 Token 统计的单元数、没有运行时长记录的单元数、是否不完整。

### 8.3 两段对比

- `compare=period`：再取一次紧邻的上一个等长时间范围的汇总作为基线。
- `compare=version&split=N`：同一时间范围内，把单元按 `subjectRevision < N` 与 `≥ N` 分成基线和当前两组；`subjectRevision` 为空的单元归基线。工作组不接受这个取值（422）。
- 响应里每个关键指标带基线值、变化幅度和方向；阶段表的时长与 Token 带基线值。

## 9. 文本主题分析

### 9.1 流程

```text
POST …/insight     受理：同一能力、同一范围已有待执行或执行中的分析则返回它；否则插入 pending 行
后台作业（每 2 秒）  取一条 pending → 置 running → 取原文 → 运行模型 → 校验 → 计数 → 置 done 或 failed
GET …/insight      返回该查看者范围内最近一次结果，以及是否有新内容
开机              把上次留下的 running 行置为 failed（原因：进程重启）
```

- 范围：`canReadAll` 的查看者发起的分析范围为 `all`；其他人为 `user` 加自己的用户 ID。执行时用受理时记下的范围重建 `viewer`，原文只来自该范围可见的单元。
- 可见性：范围为 `all` 的结果对 `canReadAll` 的查看者可见；范围为 `user` 的结果只对该用户可见。
- 定时：设置为每周时，后台作业每小时检查一次，为“距上次范围为 all 的分析已满 7 天、且期间有新的单元”的能力各插入一条范围为 `all`、时间范围为近 30 天的 pending 行，每次最多 5 个能力。

### 9.2 输入与输出

- 原文来源：collaboration 的 `texts`（评审意见与退回理由、反问问题与回答），工作组的 `texts`（人发的消息、完成确认的驳回意见），数字员工的 `texts`（人提的反馈）。每条带来源、单元、阶段和时间。
- 上限：最多 400 条、合计 240 KB；超出时取最近的；单条超过 600 字符截断。每条分配一个短编号（如 `r12`）。
- 提示词要求模型只输出一个 JSON 对象：

```json
{ "groups": [ { "source": "review", "themes": [ { "name": "…", "itemIds": ["r3", "r12"], "advice": "…" } ] } ] }
```

- 校验（`themes.ts`）：用 zod 解析；丢弃不存在的编号；同一来源里一条原文只归第一个引用它的主题；没有有效编号的主题丢弃；每个来源最多保留 6 个主题，其余原文归“其它”。
- 条数、占比、涉及的阶段都由平台按归类结果从原文计算；摘录取该主题下最短的两条原文的原样文本，并带单元 ID 供跳转。模型返回的任何数字都不采用。
- 解析失败时用同一会话追加一次纠正提示重试；仍失败则置 failed。

### 9.3 运行

- 经本模块的分析运行器端口调用系统 Agent 运行通道，由装配根适配；`feature` 与观测类别都是 `process-insight`，观测行的 `owner_user_id` 为发起人（定时为空）、`task_id` 为空。前端的系统执行类别名在 `i18n/runObservability.ts` 增加一项。
- 运行时取设置 `processInsightRuntime`，为空时走 `resolveInternalAgentRuntime` 的既有回落到默认运行时（调研：`runtime-management/application/runtimeRegistry.ts:236-279`）。
- 超时沿用通道默认的 10 分钟；工作区用共享命名空间；结束后释放保留内容。
- 同一时刻只运行一条分析。

### 9.4 设置

| 设置 | 类型 | 默认 |
| --- | --- | --- |
| `processInsightRuntime` | 运行时名称，可空 | 空（用默认运行时） |
| `processInsightSchedule` | `manual` 或 `weekly` | `manual` |

设置页“运行时”分区里与“变更叙述运行时”并列增加一项；触发方式放在同一分区。

## 10. 数据模型

### 10.1 `observation_operations`

| 列 | 说明 |
| --- | --- |
| `id` | ULID |
| `action` | 闭集，见 §5.4 |
| `subject_kind` | `task`、`node-run`、`employee-case` |
| `subject_id` | 对象 ID |
| `actor_user_id` | 操作人 |
| `transport` | `http`、`mcp` |
| `first_at`、`last_at` | 毫秒时间戳；`each` 模式两者相等 |

索引：`(subject_kind, subject_id, action, last_at)`、`(actor_user_id, action, subject_kind, subject_id, last_at)`（合并时查最近一条用）。不建指向任务的外键：任务删除后这些行留着也无害，读取总是从可见单元出发。

### 10.2 `observation_insight_analyses`

| 列 | 说明 |
| --- | --- |
| `id` | ULID |
| `subject_kind`、`subject_id`、`subject_name` | 能力 |
| `scope_kind`、`scope_user_id` | `all`，或 `user` 加用户 ID |
| `window_from`、`window_to` | 分析覆盖的时间范围 |
| `trigger` | `manual`、`scheduled` |
| `requested_by` | 发起人，可空 |
| `status` | `pending`、`running`、`done`、`failed` |
| `input_json` | 各来源的条数、是否截断、最新一条原文的时间 |
| `result_json` | 主题结果，可空 |
| `error_code`、`error_message` | 可空 |
| `created_at`、`started_at`、`finished_at` | 时间 |

索引：`(subject_kind, subject_id, scope_kind, scope_user_id, created_at)`、`(status, created_at)`。每个能力、每个范围只保留最近 5 条，受理新分析时删除更早的。

### 10.3 结构版本与配套文件

两张表都属于 run-observability，保留类别为 `business`（与现有三张观测表相同）。按现行流程（调研，先例为 `c37b675ff` 与 `9498cca64`）：

1. 在 `run-observability/infrastructure/persistence/schema.ts` 用 `owner.table({...})` 声明并加入 `schemaContribution.tables`；从 `composition/schema.ts` 与 `composition.ts` 转出；在 `bootstrap/persistenceSchema.ts` 的表导出里加上两个符号；在 `bootstrap/targetSchemaRoster.json` 各加一条。
2. 结构历史：`packages/backend/db/schema-history/epoch2/` 每张表一个版本（一个 `add-table` 只能加一张表），接在当前最高版本之后。命令为 `bun run scripts/schema-history.ts --append add-table <slug> --postgresql-url-env <VAR>`，再对 PostgreSQL 15、16、17、18 各跑一次 `--catalog`，最后 `--check`。**结构历史不可改写，所以这一步放在全部实现与用例写完、表结构定稿之后。**
3. 每个版本配一份种子 `tests/fixtures/release-upgrade/seeds/epoch2/NNNN.json`（升级后新表为空）和 `tests/fixtures/release-upgrade/mapping-oracle.json` 里的一条。
4. 两处表数量断言各加 2：`tests/backup.test.ts:170-172`、`tests/rfc349-postgresql-provider-backup.test.ts:229-231`。
5. `tests/architecture/rfc371-v2-observation-boundaries.test.ts` 的观测表符号集合加上两张新表，导入白名单加上平台合同一项。

不涉及：已冻结的 epoch-1 迁移目录、`targetColumnDestinations.json`、任务归档的表清单。

并发提示：另一个在途的 RFC-615 正在处理“历史行桥对每个版本建一座桥”的用例超时；本 RFC 再加两个版本会让该用例更慢。发布前要看那边是否已落地，并在计划里记录。

## 11. 前端

### 11.1 路由与数据

- 页签：`RunObservability.tsx` 的页签增加 `process`。查询参数增加 `kind`、`subject`、`view`、`compare`、`split`、`origin`、`unit`，全部可分享。时间范围增加“近 90 天”。
- 客户端：`components/process-metrics/processClient.ts`，查询键前缀 `['observability', 'process']`。能力汇总是一次较重的计算，不自动轮询，由页面上的刷新按钮和切换筛选触发；文本主题分析在执行中时每 2 秒轮询它自己的状态。
- 入口：工作流编辑页与工作组详情页的“更多”各加一个 `ResourceActionItem`；数字员工卡片的操作区加一个链接。三处都跳到 `/observability?tab=process&kind=…&subject=…`。

### 11.2 组件

`components/process-metrics/`：`ProcessMetrics.tsx`（列表与详情的外壳）、`ProcessSubjectList.tsx`、`ProcessOverview.tsx`、`ProcessStages.tsx`、`ProcessRounds.tsx`、`ProcessMembers.tsx`、`ProcessDuties.tsx`、`ProcessGates.tsx`、`ProcessUnits.tsx`、`ProcessInsights.tsx`、`processFormat.ts`、`processHeat.ts`。

新增的公共组件（`components/`，各带样式命名空间、i18n、单测；现有观测总览的四张指标卡同时改用 `MetricTile`）：

| 组件 | 用途 |
| --- | --- |
| `MetricTile`、`MetricGrid` | 指标卡：标签、数值、说明、可选的变化行 |
| `SegmentedBar` | 一个整体拆成几部分：高条（数值印在块内，放不下不印）与细条（表格行内）。最多四个分类色，其余的部分并成一段弱化色（如 Token 按原因拆分里的“其它重跑与系统工作”），各项的完整数值在等价表格里 |
| `MeterBar` | 表格单元格里的比例条 |
| `ColumnChart` | 有序类别的柱状图 |
| `TrendChart` | 单序列折线，带十字线与数据表 |
| `HeatScale` | 五档色标与图例 |

每个图表都有等价的表格或图例数值；悬停与键盘焦点显示同样的提示。表格都放在 `TableViewport` 里，分段控件都用 `Segmented`（`packages/frontend/tests/ux-source-ratchets.test.ts` 的既有守卫）。

图表配色作为设计 token 加进 `styles.css`（明暗两套）：四个分类色 `--viz-cat-1..4`、一个弱化色 `--viz-other`、三档有序色 `--viz-ord-1..3`、五档热力色 `--viz-heat-1..5` 及各自的文字色。取值即原型里用的那一组，已用配色校验脚本在两种主题的面板底色上校验过：分类色相邻对的色觉缺陷区分度最低 11.1，正常视觉最低 21.1；有序色与热力色的明度单调。状态色沿用现有的语义 token。

### 11.3 画布与职责图

- `WorkflowCanvas` 增加可选属性 `nodeHeat?: Readonly<Record<string, { level: 1 | 2 | 3 | 4 | 5; label: string }>>`，经 `toFlowNodes` 写入 `CanvasNodeData.heat`，`CanvasNodeCard` 输出 `data-heat` 并多显示一行数值。属性未传时，画布的输出与改动前逐字相同（沿用 `canvas/nodes/types.ts:106-112` 的约定）。度量页用 `surface="task"` 的只读画布，定义取能力汇总里带回的冻结定义。
- `EmployeeCapabilityPanorama` 的 `EmployeeCapabilityToolState` 增加可选的 `heat?: 1 | 2 | 3 | 4 | 5`，卡片输出 `data-heat`。未传时不变。
- 两处的着色样式都只引用 `--viz-heat-*`。

### 11.4 文案

`i18n/processMetrics.ts` 导出中英两份与类型，挂为顶层命名空间 `processMetrics`。提示文案的键为 `processMetrics.hint.<规则标识>.title` 与 `.body`。

## 12. 失败模式

| 情况 | 行为 |
| --- | --- |
| 人的操作写入失败、写窗口未开、没有绑定记录器 | 不记录，原操作照常成功 |
| 某个事实接口抛错 | 整个汇总请求失败并返回错误，不把缺失当成 0 |
| 单元超过上限 | 取最近的，响应带 `partial`，页面注明 |
| 单元仍在运行 | 出现在明细里；不进时长、一次通过率和 Token 的统计 |
| 人工门还没有关闭 | 计入等人时间（到单元结束或当前时刻），不进该类门的时长分布 |
| 单元开始时间早于最早的调用记录 | 不进 Token 与成本的统计，响应里给出个数 |
| 单元没有运行时长记录 | 不进时间拆分的统计，响应里给出个数 |
| 样本数为 0 的比率与分位数 | 返回 null，页面显示“—”，不显示 0 |
| 冻结定义解析失败 | 阶段目录退化为只有节点 ID 的平铺列表，画布不显示，表格照常 |
| 工作流已删除 | 名称显示“已删除的工作流”，度量照常 |
| 职责图清单取不到（类型修订已退役且无记录） | 工作项按引用名平铺显示，职责图不显示 |
| 类型没有声明返工类工作项或没有实现反馈投影 | 一次通过率、人提的反馈条数显示“不适用”，文本主题分析没有这一来源 |
| 调用的 `node_run_id` 找不到对应节点执行（任务已删除等） | 计入单元合计，归到“未归属”阶段 |
| 文本主题分析的模型输出不合格式 | 纠正重试一次，仍失败置 failed 并保留错误信息；上一次成功的结果继续可见 |
| 分析执行中进程重启 | 开机置 failed，可重新发起 |
| 没有可分析的原文 | 受理时直接返回“没有内容”，不调用模型 |

## 13. 性能

- 每个接口方法都按 ID 分块。走索引的：`node_runs` 的 `(task_id, …)` 与 `(task_id, container_run_id, …)`，`doc_versions` 与 `clarify_rounds` 的任务索引，`observation_calls` 的 `(task_id, started_at)`，`tasks` 的父任务索引，事件表的主体索引。不走索引的只有一处：数字员工的轮次表按交办读取（§6.3），集中验证时实测并按结果处置。
- 2,000 个单元的能力汇总：4 块 × 约 14 条查询；节点执行索引约 10 万行、`comments_json` 与 `questions_json` 的解析量约 12 MB（按每任务 50 次执行、两个评审轮、每轮五条意见估算）。目标是本机 SQLite 上 2 秒内返回（AC-13），集中验证阶段用 2,000 个任务的夹具实测；达不到时把上限调到能达到的值，并在 plan 记录。
- 能力列表不取节点执行索引、不解析 JSON，5,000 个单元约 10 块 × 5 条查询。
- 守护进程用同步的 SQLite 连接，慢查询会阻塞其它请求；因此每条查询都限定在 500 个 ID 之内，块与块之间让出事件循环。
- 不做结果缓存，也不自动轮询汇总。页面一次取回整个汇总，各页签共用同一份响应。

## 14. 测试策略

实现与测试用例全部写完后集中验证（仓库硬规则）。必写的用例：

**领域（纯函数）**
- 执行原因归类：对 `RERUN_CAUSES` 的每个值断言归类；源码层断言 `PROCESS_CAUSE_OF` 带 `satisfies Record<RerunCause, …>`；重跑原因为空归首次；提交与推送的容器行不计时；人工重试的占位行不计为执行也不计为失败，只计一次人工重试；仓库准备的 `retry-node` 行计为恢复续跑。
- 包装器换代的改判：首代、同帧第二代、循环套循环的内层首代、祖先换代。
- 阶段目录：已移除的节点、五类平台合成节点、未归属。
- 时间拆分：无门、单门、多门重叠、门与运行重叠、门超出单元起止、未结束的门、作废轮次计入等人、没有运行时长记录；三项之和等于总历时。
- 统计：空集、单值、偶数个值的中位数与 P90；比率分母为 0 返回 null。
- 排名分档：单值、两值、并列值、极端值、不适用。
- 人工门聚合：被系统连带作废与被刷新作废的评审不计轮次与决定；实例内序号；首轮通过率；取消与放弃的反问不进回答时间；人均意见数排除零意见轮。
- 响应等待：会话与轮次相交取最早一条、`max(first_at, openedAt)`、没有相交为空。
- 回答方式四类判定与推荐采纳率的分母；脑图深度（链、分叉、缺父）；追问生成的调用按时间归轮。
- 一次通过：评审返工、自动重试、失败的执行、人工重试各自使其不成立；人工重试一个已成功的节点同样不成立；中断后恢复、取消后续跑、连带重跑、反问后续跑不影响。
- 人工介入次数的三项来源各自计入；作废的人工门轮次不计。
- 稳定性各项计数；循环“触顶或跑满上限”的两种来源。
- 提示规则：每条规则在阈值两侧、样本数门槛两侧。
- 文本主题：不存在的编号、重复归类、空主题、超过 6 个主题、摘录为原文、条数上限与单条截断。
- 两段对比：变化幅度与方向（升为好与降为好两类指标）。

**事实实现（SQLite 与 PostgreSQL，`describeEachProvider`）**
- 任务事实：可见性（owner、协作成员、读全部）、来源推导、内部任务与子任务计入、有效运行时长减去调用等人、没有运行时长记录为 null、超过 500 抛错。
- 子孙任务：一层与多层、挂到正确的调用节点。
- 执行聚合：各重跑原因（用真实的人工重试、续跑、评审迭代流程造数，不手写行）、被评审取代的行不算失败、中断计数、包装器的序号与帧、轮数与分片数、触顶与分片失败。
- 人工门事实：单文档与多文档评审、意见归档前后计数一致、兄弟连带作废、取消的反问取中介节点执行的结束时间、历史回答的读取、工作组的 `__wg_clarify__`。
- 工作组事实：三种模式；归属规则的每个分支（Leader、消息轮、批次、单张派单经唯一 Agent、同一 Agent 多成员归不出来）；人类成员交付与取消；完成确认的决定与停驻行配对、停驻行不算 Leader 的执行、驳回后多跑的轮数；人发的消息只计聊天与派单。
- 房间投影回归：改用 shared 里的归属规则之后输出与之前逐字相同。
- 数字员工事实：可见性、轮次（含协作类与没启动就失败的轮次）、终态种类到状态的映射（含普通完成）、状态变化序列得出的阻塞区间、分界时间、类型声明的返工类工作项与反馈投影（已实现、未实现、返回值不合法）、清单缺失。
- 事件历史：按主体取、按时间排序。
- 调用存储：按节点执行汇总、两个标记、最早调用时间。
- 人的操作存储：会话合并（30 分钟内合并、超过则新开、60 秒内不重复更新）、逐次记录、按对象读取。
- 分析存储：受理去重、状态迁移、开机修复、只保留最近 5 条。

**登记点**
- 声明了 `observe` 的路由成功后记录（HTTP 与 MCP 两种传输）；失败不记录；未声明不记录；未绑定记录器不记录；写窗口未开不记录；`daemon` 来源不记录；记录器抛错不影响响应。
- `sameMeta`：只有 `observe` 不同的重复声明被拒绝；内容相同的两个不同对象不被拒绝。
- 源码层：§5.4 表里的每条路由都带对应的 `observe`；`observe` 写在 `path` 之后。

**用例与 HTTP**
- 三类能力的汇总与单元明细（每类一个覆盖主要路径的夹具），数字与夹具逐项对上；同一任务的 Token 与运行观测任务页一致。
- 调用节点的时长与 Token；子任务同时作为被调用工作流的单元。
- 范围：普通成员只统计可见单元；按人明细对其为 null；超过上限带 `partial`；数据说明字段。
- 两段对比两种方式；工作组拒绝按版本分界。
- 文本主题分析：受理、执行（运行器用替身）、范围隔离、定时插入、没有内容、失败重试、消耗写入观测。
- §12 的各条退化。

**架构守卫**
- run-observability 不读其它模块的表、不 import 其它模块；五个事实实现只 import 平台合同；`registry.ts` 不 import 任何模块；各模块 `composition/` 里没有控制流。
- 既有守卫照常通过：目标依赖图、观测边界、公开符号有消费方、表归属、路由与端点清单、后台作业清单。

**前端**
- 六个公共组件的单测（含键盘焦点提示、放不下不印标签、等价表格）。
- 三类能力各页签的渲染；筛选、展开、对比、身份差异（按人明细不可见时的说明）；数据说明与各类“不适用”。
- `WorkflowCanvas` 与 `EmployeeCapabilityPanorama`：未传热力属性时输出与改动前一致的源码层断言与渲染断言。
- 三处入口链接。
- e2e：`process-metrics.spec.ts`，覆盖列表、三类详情、热力图、分析的手动触发；1280 与 390 宽度，明暗主题。

## 15. 待核实项

实现前须逐条对源码复核。标“已核”的是设计门或我本人对着源码读过的，其余是调研结论：

1. 平台合成节点 ID：`__repo_prep__`、`__commit_push__` 与 `__commit_push__:<节点>`、`__merge_resolve__` 前缀、`__dw_orchestrator__`、`__wg_leader__`、`__wg_member__`、`__wg_clarify__`（已核存在：`task-execution/infrastructure/migration/run/writers.ts:47-87`、`source-control/domain/mergeConflictResolution.ts:31`）；实现时再确认没有遗漏的前缀，漏掉的归“其它系统工作”。
2. 工作组各类宿主执行的 `shard_key` 编码与 `wg_round` 取值（已核）；完成确认消息正文的固定前缀 `completion gate APPROVED` / `completion gate REJECTED: `（已核）。
3. 动态工作流任务的 `engine_kind` 取值与方案驳回轮数的存放位置（已核，§2）；方案确认的停驻行是否带轮次。
4. 研发类型的返工类工作项引用名；清单里主干泳道最后一个工作项是“提交 MR”（已核）。
5. 交办的生命周期事件经发件箱写入事件表，路由事实在摘要字段里，没有清理逻辑（已核）。
6. 调用节点等人账本的批量读取方式（`node_run_runtime_states.wrapper_progress_json`）；因超限被取消的错误摘要取值；仓库准备重试的触发方（确认它的 `retry-node` 行计一次人工重试是否恰当）。
7. `resolveInternalAgentRuntime` 对新增设置项的接入方式；运行时名称类设置的引用守卫（`runtime-management/domain/runtimeProfile.ts:349-357`）。
8. §10.3 的结构版本流程与四个 PostgreSQL 大版本的目录生成环境。
9. 新后台作业要登记的位置与要更新的清单用例（`bootstrap/daemonLifecycleProgram.ts:77-132`、`tests/rfc379-daemon-lifecycle.test.ts:56-73`、`tests/rfc349-sqlite-daemon-pausable-writers.test.ts:28-42`、`tests/rfc380-daemon-module-bundles.test.ts:235-248`）。
10. 新路由要登记的清单（`tests/contracts/registry.ts:956-1054`、`tests/architecture/rfc329McpSurfaceLedger.ts:172-202`、`tests/architecture/rfc319-endpoint-coverage.test.ts:55-65`、`architecture/e2e-endpoint-coverage.json`）。
11. `architecture/counts.json` 里与本 RFC 相关的上限：各模块 `composition-control-flow-*` 为 0、无消费方的公开符号为 0、目标依赖图之外的文件对。
