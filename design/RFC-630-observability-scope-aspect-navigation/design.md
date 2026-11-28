# RFC-630 技术设计：运行观测按领域模型重排

配套：[产品方案](./proposal.md) · [交付计划](./plan.md) · [页面原型](./prototype/index.html)

路径约定：`RO` = `packages/backend/src/modules/run-observability`，`TE` = `packages/backend/src/modules/task-execution`，`FE` = `packages/frontend/src`，`SH` = `packages/shared/src`。

## 1. 摘要

- 后端只保留一套读模型：RFC-616 的过程引擎（`RO/domain/process`、`RO/application/process`）扩成整页的唯一引擎，RFC-371 v2 的用量读路径（总览、任务、Agent、模型、系统执行六条路由及其查询）删除。调用账本的写入、价格、文本主题分析不动。
- 引擎从“一个能力”推广到“一个范围”：全部、某一类型、某个能力、某个任务或交办，加一个可选的“只看”。事实仍按单元装配，每个任务只算在它自己的能力里；新增的是多类型的范围装配、限制到运行里的一部分、按维度分组。
- 新增三项事实：未结束的单元（不带时间范围）、任务的谱系（类型、来源能力、所属交办、是否可见与已删除）、告警与恢复记录。前两项由 task-execution 与 digital-employee 在现有合同上扩展，第三项是 system-operations 实现的一份新的中立合同。
- 不新增表、列、索引、派生数据与后台作业；没有结构版本变化，也没有迁移。
- 前端一个路由、一个页面壳、七个关注面；过程度量的卡片按主题重新归位，用量页签的组件删除。新增两个公共组件（范围条、可排序表头），扩展四个（时间轴、柱图、指标卡、填充色）；时间行用现有的分段控件与日期时间输入。
- 读路由由十条变成八条：`scopes`、`summary`、`units`、`calls`、`units/:type/:unitId`、`units/:type/:unitId/calls`、`live`、`actual`；`insight` 两条与价格三条不变。

## 2. 已核实的事实

以下各条都读过源码（2026-11-27），设计门又逐条对过一遍。

### 2.1 现在的两套读路径

| 事实 | 位置 |
| --- | --- |
| 用量读路径按调用开始时间聚合，任务计数另按任务开始时间取 | `RO/application/observationQueries.ts:260-322` |
| 用量读路径里每个任务的消耗只算它自己的调用 | `RO/application/observationQueries.ts:334-337,368-371` |
| 用量读路径的调用过滤只有时间、任务集合、业务或系统、系统类别；没有 Agent 与模型 | `RO/application/ports/callStore.ts:56-62` |
| 过程引擎的 `summary()`、`units()`、`unit()` 各取一个 `(kind, subjectId)` | `RO/application/process/processQueries.ts:323-575` |
| 能力类型只有三种 | `SH/schemas/processMetrics.ts:17` |
| 任务侧的 `units()` 按 `subject_kind = kind` 取，`kind` 只收工作流与工作组；`unit()` 写死这两种 | `packages/backend/src/platform/contracts/processFacts.ts:149`、`TE/infrastructure/processTaskFacts.ts:334,361` |
| 被调起的任务与数字员工的宿主任务也是各自能力的单元（不按 `parent_task_id` 与 `catalog_visibility` 过滤） | `TE/infrastructure/processTaskFacts.ts:325-326` |
| 来源的判定：有员工轮或交办的是“数字员工调用”，有父任务的是“子任务”，其余取启动来源 | `TE/infrastructure/processTaskFacts.ts:156-160` |
| 装配一批任务时，执行、节点执行、包装器只读这批任务自己的；人工门与用量连子孙一起读 | `RO/application/process/sources.ts:173-208` |
| 子孙的用量折进父单元，并记在调用节点那次执行的原因上 | `RO/application/process/kinds/taskUnits.ts:234-237,285-310` |
| `descendants` 逐级走完全部层级 | `TE/infrastructure/processTaskFacts.ts:438-501` |
| 人工门的统计不含继承来的轮次；人工介入次数含 | `RO/domain/process/gateSummary.ts:31-37`、`RO/domain/process/unitSummary.ts:122` |
| 交办的执行是各轮，评审与反问取自各轮的宿主任务 | `RO/application/process/kinds/employee.ts:227-233,253-364` |
| 一轮的宿主任务有两种主体：合成的数字员工宿主，或一个被当作工具的工作流；两种都带轮 ID，交办现在把两种的用量与人工门都折进来 | `TE/infrastructure/hostTaskLaunch.ts:122-160`、`TE/infrastructure/processTaskFacts.ts:603-626`、`RO/application/process/kinds/employee.ts:293-343` |
| 用量读路径的任务计数只数公开的任务 | `TE/infrastructure/taskObservationFacts.ts:150-156` |
| 工作组任务自己的三类人工门由工作组装配器按传入的任务读取 | `RO/application/process/kinds/workgroup.ts:223-232` |
| 状态映射：已完成 → succeeded，失败、已取消各自对应，其余（含已中断）→ active | `RO/application/process/kinds/taskUnits.ts:39-46,58` |
| “Token 花在哪里”是 Token 样本上每个单元的均值 | `RO/domain/process/unitSummary.ts:228-262` |
| 按节点执行的用量聚合不带 Agent、运行时、模型 | `RO/application/ports/callStore.ts:115-127` |
| 一次调用的合计等于它各模型行之和，成本同理 | `RO/application/recordCalls.ts:84-86`、`RO/domain/pricing.ts:78-88` |
| 调用聚合里的失败数含中断 | `RO/infrastructure/callPersistence.ts:48` |
| 节点执行的事实行已经带开始、结束、状态、失败码、重跑原因 | `packages/backend/src/platform/contracts/processFacts.ts:124-138` |
| 单代理任务：`subject_kind='agent'`，`source_id` 是 Agent 的 ID，`source_name` 是冻结的名称，`engine_kind='dag'`；启动时可以允许反问 | `TE/domain/taskCreation.ts:167-196`、`TE/application/launch/taskLaunchArms.ts:165,229-236`；参考库 7 个任务的数据与此一致 |
| 代码检视（`code-round`）任务的写入方已移除，不能再创建 | `packages/backend/src/modules/integration/application/webhookTriggers.ts:215-220` |
| 告警表与恢复记录归 system-operations，告警有按任务与按未解决的两个索引 | `packages/backend/src/modules/system-operations/infrastructure/persistence/schema.ts:130-152,300-321` |
| task-execution 读告警表是登记在册的归属债，只许减少 | `packages/backend/tests/fixtures/rfc395-module-table-ownership-debt.json:246-296` |
| 事实合同文件只允许类型与两个常量 | `packages/backend/tests/architecture/rfc616-process-metrics-boundaries.test.ts:149-164` |
| 目标依赖图里 run-observability 只依赖 runtime-management，task-execution 依赖 run-observability | `design/RFC-294-backend-layered-target-architecture/design.md:150-156` |

### 2.2 量级

参考安装（用户的真实数据副本，只读查询）：5 个月 537 个任务（工作流 202、工作组 70、数字员工的内部宿主任务 258、单代理 7），3,526 次节点执行，27 次交办，23 个被调起的任务（工作流调工作流 12、工作流调工作组 11），97 条告警（69 条未解决），49 个已中断的任务。任务历时的中位数 2.4 分钟，38 个超过 24 小时。

每 30 天约 100 个任务，比上限低一个数量级以上。设计仍按上限做到有界。

### 2.3 前端

| 事实 | 位置 |
| --- | --- |
| 页面壳、页签切换时丢参数的规则 | `FE/components/observability/RunObservability.tsx:58-111` |
| 地址参数的校验分两处 | `FE/routes/observability.tsx:17-34`、`FE/components/process-metrics/processSearch.ts:65-94` |
| 三个入口共用一个链接函数 | `FE/components/process-metrics/processSearch.ts:100-110` |
| 时间轴组件每行一条，只有这一个使用方 | `FE/components/ExecutionSwimlane.tsx`、`FE/components/observability/ObservationTaskDetail.tsx:121` |
| 公共库已有页码翻页；游标翻页是任务页签里的私有组件 | `FE/components/Pagination.tsx`、`FE/components/observability/ObservationTasks.tsx:154-183` |
| 公共的文本输入支持日期时间类型，价格编辑的生效时间在用 | `FE/components/Form.tsx:102`、`FE/components/observability/PriceEditor.tsx:87`、`FE/components/observability/priceDraft.ts` |
| 没有面包屑、可排序表头、堆叠柱图 | `FE/components` 下无对应文件；`FE/styles.css` 无 `aria-sort` 相关样式 |
| 节点抽屉有两个使用方 | `FE/routes/tasks.detail.tsx:1046-1063`、`FE/components/workgroup/room/WorkgroupRoom.tsx:28` |
| 设置页文本主题分析的说明里用到“过程度量”“系统执行”“人的介入”，并有用例断言其中含观测页的页签名 | `FE/i18n/zh-CN.ts:9629-9646`、`packages/frontend/tests/rfc616-settings-process-insight.test.tsx:456` |
| 两套格式化函数、两份文案 | `FE/components/observability/observationFormat.ts`、`FE/components/process-metrics/processFormat.ts`、`FE/i18n/runObservability.ts`、`FE/i18n/processMetrics.ts` |

## 3. 架构落位（RFC-294）

### 3.1 所在的 bounded context 与分层

bounded context 仍是 `run-observability`。本 RFC 的代码按目标分层落位：

| 层 | 改动 |
| --- | --- |
| `domain/process/` | 新增 `scope.ts`（范围、只看、粒度）、`parts.ts`（限制到运行里的一部分）、`measures.ts`（一组度量的定义与合并）、`breakdown.ts`（按维度分组）、`buckets.ts`（时间分段）；`model.ts`、`unitSummary.ts`、`stageSummary.ts`、`gateSummary.ts`、`hints.ts` 扩展。全部是纯函数 |
| `application/process/` | 新增 `scopeLoader.ts`（范围装配）、`observationQueries.ts`（八个用例）、`actualSpend.ts`、`liveState.ts`；`kinds/*` 与 `sources.ts` 扩展；`processQueries.ts` 被替换后删除 |
| `application/ports/` | `callStore.ts` 扩展；`taskFacts.ts` 删除 |
| `infrastructure/` | `callPersistence.ts` 扩展（两套切片、过滤、按条件取调用） |
| `inbound/http/` | 新增 `observabilityRoutes.ts`；价格路由移到 `pricingRoutes.ts`；`observationRoutes.ts` 与 `processRoutes.ts` 里被替换的路由删除，后者只留文本主题分析两条 |
| `composition/` | `runObservation.ts` 与 `processMetrics.ts` 合成一份装配，只构造与注入 |
| `public/` | `queries.ts` 去掉任务事实端口的导出 |

### 3.2 跨模块的事实

沿用 RFC-616 的做法：合同在中立位置，拥有方实现，装配根绑定；run-observability 不 import 任何拥有方。

| 合同 | 改动 | 实现方与位置 |
| --- | --- | --- |
| `ProcessTaskFacts.units` | `kind` 改为 `kinds[]`，可取工作流、工作组、单代理；行增加 `subjectKind`，单代理任务的 `subjectName` 取冻结的名称 | task-execution，`TE/infrastructure/processTaskFacts.ts` |
| `ProcessTaskFacts.activeUnits` | 新增。不带时间范围的未结束任务，只取三种单元类型并按能力过滤，按开始时间从新到旧，最多取上限加一行。`phase` 取 `open`（排队、运行中、等待评审、等待人工）或 `interrupted`（已中断），各自返回行 | 同上 |
| `ProcessTaskFacts.reactionHostTasks` | 行增加宿主任务的主体类型，用来区分内部宿主任务与被当作工具的工作流任务 | 同上 |
| `ProcessTaskFacts.unit` | 接受单代理；任务是数字员工的内部宿主任务（`subject_kind='digital-employee'`）时返回它所属交办的 ID，由调用方改查交办 | 同上 |
| `ProcessTaskFacts.lineage` | 新增，取代没有使用方的 `taskSummaries`。按任务 ID 批量返回：类型、来源能力的 ID 与名称、开始时间、发起人、版本、来源、员工轮与交办 ID、对查看者是否可见、是否已删除 | 同上 |
| `ProcessEmployeeFacts.activeCases`、`casesOfRounds` | 新增。未结束的交办；由轮 ID 查交办与它所属的员工 | digital-employee，`packages/backend/src/modules/digital-employee/infrastructure/processEmployeeFacts.ts` |
| `ProcessAlertFacts` | 新合同：`alerts(taskIds)`、`openAlerts(limit)`（另返回未解决的总数）、`recoveryEvents(taskIds)` | system-operations，新文件 `infrastructure/processAlertFacts.ts` 与 `composition/processAlertFacts.ts` |

- 告警合同放在 `packages/backend/src/platform/contracts/processFacts.ts`，与其它五个接口并列。它不带查看者：`openAlerts` 返回任务 ID 与告警行，run-observability 再用 `lineage(viewer, …)` 过滤可见性并对到范围。system-operations 读的是自己的表，归属债不增加。
- 上限常量放在 `SH/schemas/observability.ts`。合同文件仍然只有类型与原有的两个常量。
- 绑定在 `packages/backend/src/bootstrap/daemonHttpComposition.ts:471-489`：增加 `alerts`，去掉 `createTaskObservationFacts`。
- run-observability 的导入白名单不变（仍只有平台合同一项）。

### 3.3 本 RFC 承担的演进与留下的债

- **演进**：run-observability 的读模型由两套并成一套；用量读路径专用的任务事实端口（`ObservationTaskFactsPort`）连同 task-execution 里的实现一起删除，跨模块的读取统一走平台合同。
- **演进**：告警与恢复记录第一次有了由拥有方提供的读取合同。task-execution 里那几处登记在册的直接读取不在本 RFC 范围，但以后可以改用它。
- **留下的债**：工作组房间的查询仍在 resource-catalog（RFC-616 已记录）；task-execution 对告警表的直接读取仍在归属债账本里。
- **不新增**：横向的 `routes/`、`services/` 文件，跨 context 的内部 import，装配根，表、列、索引。

### 3.4 偏离项

没有需要用户确认的偏离。说明一点：`ProcessAlertFacts` 让 system-operations 成为事实合同的第六个实现方，`rfc616-process-metrics-boundaries` 守卫里的实现方清单要随之增加一项。

## 4. 查询模型

### 4.1 共享定义

新文件 `SH/schemas/observability.ts`，放本页所有请求的 zod 定义与响应的类型（响应沿用现有做法，用接口声明）。`SH/schemas/observation.ts` 只留调用状态、用量合计、调用行、时间范围上限、价格与人民币格式化；`SH/schemas/processMetrics.ts` 保留三类能力（文本主题分析在用）、人工门与各类型汇总的既有形状、提示的定义，删去能力列表、汇总查询、单元分页的查询与响应。

```ts
export const OBSERVATION_TYPES = ['workflow', 'workgroup', 'digital-employee', 'agent', 'platform'] as const
export const OBSERVATION_ASPECTS = ['overview', 'cost', 'time', 'quality', 'human', 'stability', 'records'] as const
export const OBSERVATION_ONLY_KINDS = ['stage', 'agent', 'model', 'cause', 'system', 'origin', 'owner', 'version'] as const
export const OBSERVATION_DIMENSIONS = ['type', 'capability', 'stage', 'agent', 'model', 'cause', 'system', 'origin', 'owner', 'version', 'gate', 'handler'] as const
export const OBSERVATION_UNIT_STATUSES = ['succeeded', 'failed', 'canceled', 'interrupted', 'active'] as const
export const OBSERVATION_UNIT_FILTERS = ['all', 'running', 'waiting', 'interrupted', 'succeeded', 'failed', 'canceled'] as const
export const OBSERVATION_BUCKETS = ['1h', '3h', 'day', 'week'] as const

export const OBSERVATION_UNIT_LIMIT = 2000
export const OBSERVATION_LIVE_LIMIT = 500
export const OBSERVATION_OPEN_ALERT_ROWS = 50
export const OBSERVATION_UNIT_CALL_LIMIT = 2000
export const OBSERVATION_CALL_LIST_LIMIT = 5000
export const OBSERVATION_BREAKDOWN_ROWS = 200
export const OBSERVATION_RECENT_UNITS = 50
export const OBSERVATION_UNIT_PAGE_SIZE = 25
export const OBSERVATION_CALL_PAGE_SIZE = 50
```

- **范围**：`{ type?, capability?, unit? }`。`capability` 是来源 ID，没有来源的用保留值 `-`（沿用 `PROCESS_NO_SUBJECT`），没有 ID 的历史单代理任务用 `~名称`；平台调用下是系统工作的类别。`unit` 是任务 ID 或交办 ID，必须带 `type`。
- **只看**：`{ onlyKind, only }`。Agent 的键是 `agent_id`，为空时是 `~名称`（与 `RO/infrastructure/callPersistence.ts:94` 的分组键相同）。模型的键是 `encodeURIComponent(运行时键) + '/' + encodeURIComponent(模型名)`，两段都编码过，所以分隔符不会和内容混淆。其余是各自的取值。
- **可用性**：`SH` 里一个纯函数 `observationOnlyAllowed(position, onlyKind, viewerScope)`，前后端共用，实现 proposal §4.3 的表。不允许的组合，路由返回 422。
- **粒度**：`grain = 'part'` 当且仅当“只看”是环节、Agent、模型、执行原因、系统工作之一，或类型是平台调用；否则是 `'unit'`。
- **时间**：请求只带 `from`、`to`、`tzOffset`，服务端不知道快捷项。分段由服务端用 `SH` 里的两个纯函数从范围的长度得出，前端用同一对函数算标签，所以不需要分段参数：
  - `observationTrendBucket(span)`：不超过 12 小时 `1h`，不超过 4 天 `3h`，不超过 14 天 `day`，否则 `week`。
  - `observationActualBucket(span)`：不超过 12 小时 `1h`，不超过 4 天 `3h`，不超过 62 天 `day`，否则 `week`。
  - 段的边界按 `tzOffset` 对齐到整点、能被 3 整除的整点、零点、周一零点；首尾两段可以不满。366 天的上限下最多 53 段（按周）或 62 段（按天）。
- **提示通向哪个面**：`OBSERVATION_HINT_ASPECT`，对 14 个提示 ID 穷尽的映射（`satisfies Record<ProcessHintId, …>`），并给出人工介入里要选中的人工门种类。取代 `PROCESS_HINT_TARGETS`。

### 4.2 一组度量

`ObservationMeasures` 是汇总、基线、每个分段、“按…看”的每一行共用的一个形状。字段是原始的和与样本，比率与分位数在同一处算好一并给出，前端不再自己推导。

| 组 | 字段 |
| --- | --- |
| 数量 | `units`（整次运行粒度是个数，部分粒度是涉及的个数）、`statuses`（五类计数，只在整次运行粒度） |
| 用量 | `tokens`（四类）、`costNano`、`calls`、`failedCalls`、`incompleteCalls`、`unpricedCalls` |
| 每个的 | `perUnit: { sample, tokens, costNano }` |
| 时间 | `lead: { sample, p50, p90 }`、`time: { sample, autoMs, waitMs, otherMs, waits }`（成功且有运行时长记录的单元上的和）、`flowEfficiency`、`waitShare`、`otherShare` |
| 质量 | `successRate`、`firstPass: { sample, passed }`、`causes`（六类各自的 Token、成本、次数、时长，都是合计） |
| 执行或调用 | `runs: { count, ended, failed, retries, interrupted }`、`runMs: { sample, p50, p90, total }`、`failureCodes`（最多 10 个） |
| 人工 | `interventions: { sample, gates, manualRetries, operations }`、`gates`（每类人工门的轮次、等待的样本与分位数与合计、有决定的轮次、未通过的轮次）、`review: { firstRounds, firstPassed }`、`clarify: { units, rounds }` |
| 系统工作 | `system`（每个类别的 Token、成本、调用数） |
| 稳定性 | `recoveries`、`manualRetries`、`limitCancellations`、`repairs` |

- 部分粒度下，只对整次运行有意义的字段为 `null`：成功率、总历时、流动效率、等人占比、一次通过、每个的人工介入、人工重试与操作（它们按任务记录，`RO/application/process/kinds/taskUnits.ts:217-219`）。
- `runs` 与 `runMs`：在环节、执行原因下数的是执行，`failed` 是失败的执行；在 Agent、模型、系统工作下数的是调用，`failed` 是失败或中断的调用（proposal §8.2 的两种失败率）。响应里用 `runsAre: 'executions' | 'calls'` 标明。
- `runMs` 的样本是每个单元在这部分上的时长之和。
- `failureCodes`：执行的失败码。按 Agent、模型时取这些调用所在的节点执行的失败码（切片带节点执行 ID）；系统工作没有。
- 每个字段的“越大越好还是越小越好”在 `SH` 里一处定义（`OBSERVATION_METRIC_BETTER`，推广 `PROCESS_METRIC_BETTER`），数量类与系统工作占比为中性。

### 4.3 状态

`ProcessUnitStatus` 增加 `interrupted`。任务状态 `interrupted` 直接映射；交办没有这个状态。`unitEnded` 改为“成功、失败或已取消”。现有用 `=== 'active'` 或 `!== 'active'` 判断“是否结束”的各处一并改掉：`RO/application/process/kinds/taskUnits.ts:58`（已中断的任务没有结束时间，总历时算到现在）、`kinds/workgroup.ts:506-507`、`kinds/employee.ts:429,567`、`processQueries.ts:98`、`RO/domain/process/unitSummary.ts:131-141`。

单元行另带对象自己的状态（任务状态的八个值，或交办的状态与结局），前端用现有的任务状态标签与交办标签显示（proposal §8.1）。

## 5. 范围装配与归属

### 5.1 单元

归属规则是 proposal §6.2：每个任务只算在它自己的能力里。

| 单元 | 取法 |
| --- | --- |
| 任务单元 | `subject_kind` 是工作流、工作组、单代理的任务，未删除，查看者可见。被调起的任务、数字员工当工具用的工作流任务都在内，来源如实标出（现有 `units()` 的行为，只是多了单代理） |
| 交办单元 | 数字员工的交办。各轮的内部宿主任务（`subject_kind='digital-employee'`）不是单元，它们的用量、评审与反问由数字员工装配器折进交办（现有行为） |
| 不是单元的 | 已删除的任务、已停用类型（`code-round`、`unknown`）的任务。它们的调用只出现在期间实际消耗里 |

因为不再有“算在发起方”的规则，只能查看自己任务的账号也不需要特殊处理：每个可见的任务就是一个单元。

### 5.2 单元的事实

相对 RFC-616 改两处，让可加的量只算自己的：

| 事实 | 现在 | 改为 |
| --- | --- | --- |
| 用量切片与用量合计 | 自己的加子孙的；子孙的记在调用节点那次执行的原因上 | 只有自己的。子孙的调用合计另存为 `invoked`（Token、成本、任务数、各子任务的引用），只用于“它调起的任务另花了”那一行 |
| 人工门轮次 | 自己的；子孙的评审与反问作为继承副本 | 不变：继承副本仍然读，只用于时间拆分里的等人。人工门的统计本来就不含继承副本 |
| 人工介入次数 | 含继承副本 | 只算自己的 |
| 执行、节点执行、包装器 | 自己的 | 不变 |

数字员工装配器只折入各轮的**内部**宿主任务（主体类型是数字员工宿主的）自己的用量、评审与反问。被当作工具的工作流任务是那个工作流的单元：它的评审与反问在交办里只作为继承副本（用于等人时间），它的调用合计进交办的 `invoked`。内部宿主任务的子孙同样不折进来（它们是自己能力的单元），进 `invoked`。

`invoked` 另按调起它的环节拆分（子孙行带调用节点，`ProcessDescendantRow.callNodeId`；交办按工作项），供按环节看时调用节点那一行的“它调起的任务”一列。

单个能力或单个单元的“它调起的任务另花了”：单元的 `invoked` 之和，按任务去重，并去掉本身就是这个范围里的单元的那些。它不进任何合计。

### 5.3 四种范围

`scopeLoader.load(viewer, position, window, depth)` 返回一组单元事实。

| 范围 | 取哪些单元 |
| --- | --- |
| 全部 | 时间范围内开始的任务单元（三种类型一次取）与交办，合并后按开始时间从新到旧，最多上限加一行。另把时间范围内没有任务的调用作为平台调用加入用量（见下） |
| 某一类型 | 同上，只取这一类型 |
| 单个能力 | 这个能力在时间范围内开始的单元（与现在的 `summary()` 相同） |
| 单个任务或交办 | 这一个单元，不带时间范围（现有 `unit()`，多了单代理） |
| 任务之外的平台调用 | 没有单元。直接从调用账本按系统工作类别聚合，按调用开始时间；没有任务的调用只统计查看者自己发起的，能查看全部任务的账号统计全部 |

- 三个装配器（任务类两个共用 `taskUnitFacts`，加数字员工）本来就按单元输出同一种事实（`RO/application/process/kinds/*.ts`），多类型的范围就是把它们的结果拼在一起。
- 装配器一批只读最新一个单元的定义（`RO/application/process/kinds/workflow.ts:83-86`），而定义里有循环的上限、脑图的分类与环节的名称。所以多能力的范围按能力分组装配：先取范围内的单元行（已截到上限），按能力分组，每组各跑一次对应的装配器，再拼起来。每个能力的环节目录、工作组模式、数字员工清单取法不变（该能力最新一个单元的）。
- **全部范围里的平台调用**：成本、Token、调用数，以及按能力类型、Agent、模型、执行原因（归系统工作）、系统工作看的各行，都把它们加进来；按能力看时每个类别是平台类型下的一行；按来源、发起人看时合成“任务之外的平台调用”一行。数量与各类单元统计不含它们。
- 各层相加相等由构造保证：每个调用属于一个任务，每个任务属于一个单元，每个单元属于一个能力与一个类型。

### 5.4 限制到运行里的一部分

`restrictToPart(facts, only, catalogue)` 对一个单元的事实做过滤，返回同一形状：

| 只看 | 留下的执行 | 留下的用量切片 | 留下的人工门 |
| --- | --- | --- | --- |
| 环节（普通） | 这个环节的 | 这个环节的 | 这个环节自己的，加上以它为评审对象的 |
| 环节（包装器） | 它内部各环节的（按环节目录的父子关系逐级包含嵌套的包装器），以及这个包装器自己的运行记录 | 它内部各环节的 | 它内部各环节的 |
| 执行原因 | 这个原因的 | 这个原因的 | 无 |
| Agent | 无（按调用统计） | 这个 Agent 的调用切片 | 评审它所在环节产出的评审，加上它所在环节提出的反问 |
| 模型 | 无 | 这个运行时与模型的模型切片 | 无 |
| 系统工作 | 这个类别的系统执行 | 这个类别的调用切片 | 无 |

过滤之后重新聚合，现有的 `stageTotalsOf`、`reviewSummaryOf` 等函数不用改就能用在结果上。“Agent 所在的环节”由调用切片得出：有这个 Agent 调用的环节。

只看包装器时，度量里的次数与时长取包装器自己的运行记录（每次运行的历时，现有的 `ProcessWrapperRun`），轮数或分片数另给；成本、Token、失败、人工门取它内部各环节的。

### 5.5 按维度分组

`breakdownOf(scope, dimension)`：

- **位置与运行的属性**（类型、能力、来源、发起人、版本）：把单元按键分组，每组算一份 `ObservationMeasures`。有“只看”时先对每个单元做 `restrictToPart`。
- **运行内部的切面**（环节、Agent、模型、执行原因、系统工作）：对每个出现过的键，取 `restrictToPart` 后算一份；这些行永远是部分粒度。已经有“只看”时，两个条件同时生效，响应把这些行标为 `drill: false`，前端不让点（proposal §4.3 的规则）。
- **人工门的种类、处理人**：直接对范围里单元自己的人工门轮次分组。处理人只在查看者能查看全部任务时计算。
- **类型特有的列**：范围是工作组或数字员工这一类型时，按能力分组的每一行另带 `extra`：工作组是模式、轮数、每个任务的派单数、协调开销；数字员工是合入率、阻塞率。用现有的能力列表行的算法（`workgroupSubjectRows`、数字员工的对应函数）。
- **行数**：每个维度最多 `OBSERVATION_BREAKDOWN_ROWS` 行，按成本从高到低保留（成本相同按数量），其余合并成一行“其余”；按环节看不截断，按环节目录的顺序。响应带 `truncated`。
- 可加性：成本与 Token 在任何维度下各行（含“其余”）相加等于范围的合计。按模型看的次数、时长、失败不可加，响应里用 `countsAdditive: false` 标明。

### 5.6 对比与分段

- 对比上一期：对紧邻的上一个等长时间范围再装配一次，给出 `baseline` 的一份度量；单个能力时环节行另带基线的时长与 Token（现有行为）。自定义范围同样适用。
- 按版本分界：沿用 `atRevision`（`processQueries.ts:268-277`），只在单个工作流或数字员工。
- 分段：按单元开始时间落入的段（§4.1 的函数），每段一份度量。

### 5.7 提示

- 单个能力：现有 `hintsOf`，全部返回。
- 全部或某一类型：对范围里每个单元数达到最小样本的能力，用同一批已装配的事实各算一次能力汇总并求提示。因为每个能力的单元集合与进入它之后的相同，两处的提示一致。然后每个能力取最严重的一条，再按“每种提示最多一条”取前四条。挑选在服务端做。
- 单代理：`HintFacts.kind` 增加这一类，只开通用的规则（等人为主、人工门等待长、反问的两条、失败重试多、很少一次通过）。
- 每条提示带所属能力的引用、通向的面、要选中的人工门种类。

## 6. 调用账本的改动

`RO/application/ports/callStore.ts` 与 `RO/infrastructure/callPersistence.ts`：

| 方法 | 说明 |
| --- | --- |
| `callSlices(taskIds)` | 取代 `usageByNodeRun`。按任务、节点执行、业务或系统、系统类别、Agent 键、运行时键分组：调用数、失败或中断的调用数、已结束的调用数、用量不完整与未定价的调用数、调用时长之和、四类 Token、成本 |
| `modelSlices(taskIds)` | 按任务、节点执行、Agent 键、运行时键、模型分组（从模型行连到调用）：四类 Token、成本，以及用到这个模型的调用数、其中失败或中断的、已结束的、调用时长之和 |
| `aggregate` 的过滤 | 增加 `agentKey`（`coalesce(agent_id, '~' ‖ agent_name)`）与 `detached`（没有任务的调用）；按时间分桶的宽度改为参数 |
| `aggregateModels` | 增加按时间桶、按任务分组与模型过滤 |
| `callsOf(filter, page)` | 取代 `taskCalls` 与 `recentCalls`。条件：任务 ID 集合，或“没有任务的调用加时间范围”；加上可选的节点执行 ID 集合、调用 ID 集合、业务或系统、Agent 键、运行时与模型、系统类别；先过滤再截取到上限，按开始时间排序，返回一页与总数。供所有调用表 |
| `systemCalls` | 行增加调用 ID，供把按时间归到反问环节的追问调用列进调用表 |

两个切片分开，是因为调用一级的数（次数、时长、失败）按模型拆开会重复；只有 Token 与成本可以按模型精确拆分。引擎在模型以外的维度都用 `callSlices`，只在按模型看与只看模型时用 `modelSlices`，一次调用用到几个模型就在几个模型下各出现一次（proposal §5.3 的说明）。

没有新增索引：这些查询都限定在任务 ID 的分块里（`(task_id, started_at)` 索引），或限定在时间范围里（`(started_at)` 索引）。Agent 键与模型的过滤只在这两种限定之内使用。

## 7. 接口

全部在 `RO/inbound/http/observabilityRoutes.ts`，门为 `tasks:read`、`tokenAccess: 'allow'`，与现有路由相同；可见范围在处理函数里按账号的范围点判定（`viewer = { userId, canReadAll }`，沿用 `processRoutes.ts` 的写法）。

公共参数：`type`、`capability`、`unit`、`onlyKind`、`only`、`from`、`to`、`tzOffset`。时间范围最长 366 天。公共响应字段：回显的范围（带各级的名称）与只看、`from`、`to`、`asOf`、`viewerScope`（`all` 或 `own`）、身份表、`note`（是否截断与上限、用量是否不完整、是否有未定价、没有调用记录的个数、没有运行时长记录的个数、没有记录原因的执行数）。

| 路由 | 另外的参数 | 返回 |
| --- | --- | --- |
| `GET /api/observability/scopes` | 无 | 五种类型各自的单元数；每种类型下的能力（ID、名称、是否已删除或没有来源、单元数）；带 `capability` 时附最近 50 个单元（ID、名称、开始时间、状态），以及工作流或数字员工出现过的版本 |
| `GET /api/observability/summary` | `compare`、`split` | `grain`、`runsAre`、各面是否适用及原因、`totals`、`baseline`、`invoked`（它调起的任务另花了，合计与按环节，只在单个能力）、`trend`、`breakdowns`（当前范围下可用的每个维度）、各类人工门的细项（沿用 RFC-616 的形状）、单个能力时该类型的汇总（沿用 `ProcessWorkflowSummary`、`ProcessWorkgroupSummary`、`ProcessEmployeeSummary`：画布定义、环节行的循环扇出与包装器历时、轮次、成员、按角色、人发的消息与派单、结局、交付周期、工作项等）、`hints`、时间范围内已解决的告警 |
| `GET /api/observability/units` | `status`、`q`、`sort`、`page` | 单元行：范围引用、名称、五类状态与对象自己的状态、来源、发起人、起止、总历时与三段时间、调用数、四类 Token、成本、人工介入、是否一次通过、类型特有的列；`total` |
| `GET /api/observability/calls` | `page` | 调用行（部分粒度或平台调用）：所属单元、环节、第几次执行、执行原因、Agent、运行时、模型、状态、起止、用量状态、四类 Token、成本、系统类别；`total`、是否截断 |
| `GET /api/observability/units/:type/:unitId` | `onlyKind`、`only` | 单元的基本情况、一份度量、`invoked`（合计、按环节、各子任务的引用）、按环节、Agent、模型、执行原因、系统工作的分组（与 `summary` 相同的结构）、各环节的类型特有列、全过程（每个环节的执行与等待，带起止、原因、状态、失败码、Agent、模型、Token、成本；调用节点带子任务的引用与子任务里的等待）、人工门的每一轮（继承来的标明在哪个子任务里）、人的操作、告警、恢复记录 |
| `GET /api/observability/units/:type/:unitId/calls` | `onlyKind`、`only`、`page` | 这个单元自己的调用行，最多 2,000 条 |
| `GET /api/observability/live` | 无时间参数 | 运行中、等人处理、已中断、未解决告警的个数与最久的等待；还在等的人工门（最多 50 条：单元、能力、环节、种类、轮次、开始等待的时间、处理人或空）；未解决的告警（最近 50 条与总数）；是否截断 |
| `GET /api/observability/actual` | 无 | 按调用开始时间：成本、四类 Token、调用数、失败或中断的调用数；其中来自更早开始的单元的成本与单元数；各分段；范围是全部时另给已删除或已停用类型的任务的那一部分（计入合计） |

细节：

- `summary` 把各个维度的分组一起返回，不单设分组接口：一次装配之后在内存里分组很便宜，而每换一个维度就重新装配 2,000 个单元不便宜（现有引擎不做结果缓存）。按任务与交办看不在 `breakdowns` 里，由 `units` 按成本排序提供。单个能力时沿用该类型的现有汇总形状，是为了让搬家的卡片（人工门细项、轮次、成员、职责图、环节的循环扇出）不用改数据接口。
- `units`：`status` 为 `all`、`succeeded`、`failed`、`canceled` 时按时间范围取；`running`、`waiting` 不带时间范围，读 `activeUnits` 的 `open` 与 `activeCases`，两者的区分见 `live`；`interrupted` 读 `activeUnits` 的 `interrupted`（交办没有这个状态）。未结束的列表各自最多取上限（500）那么多。`q` 在取到的行上按名称或 ID 匹配。排序与翻页都在取到的行上做（最多上限那么多），页码从 1 起，每页 25 个；按成本或人工介入排序时先对全部行做列表深度的装配。
- `calls`：都用 `callsOf`。平台调用取没有任务的调用加时间范围。其它情况先按范围装配单元；“只看”是 Agent、模型、系统工作时把条件传给 `callsOf`；是环节时传符合条件的节点执行 ID，反问环节另加按时间归到它的追问调用的 ID；是执行原因时传该原因的节点执行 ID，原因是系统工作时改按“系统”标记过滤（含没有节点执行的系统调用）。都是先过滤再截取到 5,000。环节、第几次执行、执行原因由节点执行的事实对上。
- `units/:type/:unitId`：任务是数字员工的内部宿主任务时，返回 409 与所属交办的引用，前端据此跳到交办。数字员工当工具用的工作流任务是工作流的单元，正常返回。找不到或不可见返回 404，与不存在同形。
- `live`：单元集合是范围内 `open` 的任务单元与未结束的交办，按开始时间从新到旧取到上限；按列表深度装配，取其中单元自己的、还没关闭的人工门轮次（不取继承副本，所以每一轮只列一次）。等人处理 = 任务状态是等待评审或等待人工，或者有这种轮次；其余算运行中。已中断的个数是 `interrupted` 取到的行数。运行属性的“只看”（来源、发起人、版本）在取到的行上过滤，所以计数与列表一致；取满上限时响应标明截断。告警：`openAlerts` 取未解决的与总数，用 `lineage` 留下可见且在范围内的。带“只看”运行内部切面的请求返回 422（proposal §5.5 规定这时不显示此刻的数字）。
- `actual` 的算法见 §8。范围是单个单元、或“只看”是环节与执行原因时返回 422。
- 旧路由删除：`/api/observability/overview`、`/tasks`、`/tasks/:id`、`/agents`、`/models`、`/system`，以及 `/api/observability/process/subjects`、`/process/subjects/:kind/:subjectId`、`/process/subjects/:kind/:subjectId/units`、`/process/units/:kind/:unitId`。文本主题分析的两条与价格的三条保留，路径不变。

## 8. 期间实际消耗

1. `aggregate({from, to, 可见范围}, 'task')`：时间范围内每个任务的调用合计。任务数沿用现有的 20,000 上限与 `partial` 标记。
2. 对这些任务每 500 个调用一次 `lineage`，得到每个任务归属的单元：任务单元就是它自己；数字员工的内部宿主任务归它的交办（经 `casesOfRounds`）。由此得到三件事：是否在当前范围内（类型、能力、来源、发起人、版本都由谱系判断）、归属单元是否早于 `from` 开始、是否已删除或属于已停用的类型。
3. 对留下的任务按 500 个一块取分段：按小时、按 3 小时、按天都用 `aggregate` 的时间桶；按周由按天的结果在内存里并成周一起始的周。范围是全部、没有“只看”、能查看全部任务时，这一步是一条不分块的聚合。
4. 没有任务的调用：范围是全部或平台调用时加进来。
5. 范围是全部时，已删除或已停用类型的任务的那一部分计入合计，并单独给出。

“只看”的处理：Agent 用 `agentKey` 过滤；模型用 `aggregateModels`（取模型行的 Token 与成本）；系统工作用现有的类别过滤；来源、发起人、版本由第 2 步的谱系判断。只看环节或执行原因时这张卡不提供：这两种切面需要把每个调用对到节点执行并归类原因，那是按单元装配的那条路径做的事。

## 9. 前端

### 9.1 路由与状态

`FE/routes/observability.tsx` 保留，校验改为调用新的纯模块 `FE/components/observability/observationSearch.ts`，它取代 `validateObservationSearch` 与 `validateProcessSearch`。

| 参数 | 取值 | 无效时 |
| --- | --- | --- |
| `aspect` | 七个面 | 概况 |
| `range` | `24h`、`7d`、`30d`、`90d`、`custom` | `30d` |
| `from`、`to` | 毫秒时间戳，只在 `range=custom` 时读；要求 `from < to`、不超过 366 天 | 回到 `30d` |
| `type`、`cap`、`unit` | 类型；能力 ID；任务或交办 ID | 逐级丢弃：`cap` 需要 `type`，`unit` 需要 `type` |
| `only` | `<种类>:<键>`，在第一个冒号处分开 | 种类在当前位置不可用时丢弃 |
| `compare`、`split` | `period`；`version` 加版本号 | 丢弃 |
| `by` | 当前面与位置下可用的维度 | 用该面的默认维度 |
| `gate` | 人工门的种类 | 用范围里第一个出现的种类 |
| `q`、`status`、`sort`、`cols`、`page` | 明细的搜索、状态、排序、列集、页码 | 默认值 |

- 旧地址里新页面不认识的参数（`tab`、`task`、`kind`、`subject`、`view`）不读；同名的参数（`range`、`q`、`status`、`compare`、`split`）按上表校验。带旧含义的 `unit` 而没有 `type` 的链接，按“`unit` 需要 `type`”落到全部 › 概况。
- 三个纯函数处理跳转：`withPosition`、`withOnly`、`withAspect`，各自先按上表丢掉不再有效的参数再归一（换范围或面时 `page` 回到 1）。`scrollResets(prev, next)`：面、类型、能力、单元、只看变化时回到顶部。
- 一个链接函数 `observationLink(target)` 供所有入口与页内跳转使用，取代 `processMetricsLink`。
- 时间范围 `observationWindow(search, anchor)`：快捷项是 `[anchor − 长度, anchor)`；自定义是 `[from, min(to, anchor))`，截到现在之后开始不早于结束的（整个范围在将来），按近 30 天处理并在时间行提示。`anchor` 的规则见 §9.4。

### 9.2 组件

新页面壳 `FE/components/observability/ObservationPage.tsx`，自上而下：`PageHeader`（标题、截至时间、刷新）、`ObservationScopeBar`、`ObservationTimeRow`、关注面的 `TabBar`、口径句与 `ObservationNotes`、内容区。

`ObservationTimeRow`：现有的 `Segmented`（四个快捷项加“自定义”）；选了自定义时，在同一行用现有的 `FilterBar` 放两个 `FilterField`（开始、结束），里面是 `TextInput type="datetime-local"`，加一个“应用”按钮。日期时间文本与时间戳的互换沿用 `priceDraft.ts` 里的做法，校验是一个纯函数 `customRangeOf(fromText, toText, now)`，返回范围或错误的文案键；出错时在行内提示，保留原来的范围。对比用另一个 `Segmented`，按版本分界时多一个版本的 `Select`。

内容区在范围是单个单元时渲染 `UnitView`，否则渲染 `AggregateView`。`AggregateView` 对每个面都是同一个顺序：当前条或现在在等谁、`ObservationTiles`、提升点、构成与变化、环节一览、`BreakdownCard`、这个面特有的卡。明细面渲染 `UnitsTable` 或 `CallsTable`，都用现有的 `Pagination`。

每个面在每种粒度、每种类型下显示哪些卡、哪些列、默认按什么看、环节一览用什么着色，集中在一个表驱动的纯模块 `aspectSpec.ts` 里，页面组件不写分支。`BreakdownCard` 的行是否可点由响应里的 `drill` 与维度的种类决定（proposal §4.3）。

现有文件的去向：

| 文件 | 处理 |
| --- | --- |
| `observability/RunObservability.tsx`、`ObservationOverview.tsx`、`ObservationTasks.tsx`、`ObservationTaskDetail.tsx`、`ObservationAgents.tsx`、`ObservationSystem.tsx`、`ObservationUsage.tsx`、`ObservationDailyChart.tsx`、`RunObservability.css` | 删除（含任务页签里私有的游标翻页）。“配置价格”的链接移到按模型看的行 |
| `observability/observationClient.ts` | 统计部分重写；价格部分原样保留；并入文本主题分析的两个调用 |
| `observability/observationFormat.ts` | 成为唯一的格式化模块（§9.5） |
| `observability/RuntimePricing.tsx`、`PriceEditor.tsx`、`PriceHistory.tsx`、`priceDraft.ts` | 保留（设置页在用）；去掉对被删样式文件的引用，数字列改用 `.viz-num` |
| `process-metrics/ProcessMetrics.tsx`、`ProcessSubject.tsx`、`ProcessSubjectList.tsx`、`processClient.ts`、`processSearch.ts` | 删除 |
| `process-metrics/processFormat.ts` | 并入 `observationFormat.ts` 后删除 |
| `process-metrics/processNames.ts`、`processHeat.ts`、`ProcessFacts.tsx` | 移入 `observability/`（`observationNames.ts`、`stageHeat.ts`、`ObservationFacts.tsx`） |
| `process-metrics/ProcessOverview.tsx` | 拆开：构成卡与按原因的说明 → `ObservationSplit`；趋势 → `ObservationTrend`；稳定性卡 → `StabilityFactsCard`；类型特有的数字 → 各面的 `TypeFactsCard`；指标卡由 `aspectSpec` 取代 |
| `process-metrics/ProcessStages.tsx` | 画布热力 → `StageOverview`（工作流），点节点等于只看这个环节；节点表与循环、扇出、包装器历时的列 → 按环节看；“所选节点”卡片删除 |
| `process-metrics/ProcessDuties.tsx` | 职责图 → `StageOverview`（数字员工）；工作项表 → 按环节看 |
| `process-metrics/ProcessMembers.tsx` | 成员表 → `StageOverview`（工作组）；完整的列 → 按环节看 |
| `process-metrics/ProcessRounds.tsx` | 保留为效率面的 `RoundsCard` |
| `process-metrics/ProcessGates.tsx` | 拆成 `GateDetails`（人工介入，由 `gate` 参数选种类）与质量面的 `ReviewOutcomeCard`、`DecisionOutcomeCard`（完成确认与方案确认的结果） |
| `process-metrics/ProcessHints.tsx` | → `HintsCard`，按钮的目标来自 `OBSERVATION_HINT_ASPECT` |
| `process-metrics/ProcessInsights.tsx` | 文本主题分析的卡 → 人工介入；外层的页签壳删除 |
| `process-metrics/ProcessUnits.tsx` | 状态、名称、时间细条 → `UnitsTable`；就地展开各环节的部分删除 |

`process-metrics/` 目录在本 RFC 之后不再存在；样式里 `.process-metrics*` 的类改名为 `.observation*`。

### 9.3 公共组件

按仓库的界面统一规则，新的一类控件做成公共组件，各带文案键、带命名空间的样式和单测。

| 组件 | 说明 |
| --- | --- |
| `FE/components/ScopeBar.tsx`（新） | 面包屑式的范围条。`segments`（每段可以带 `onGo` 或一个选择器）、`next`（进入下一层的选择器）、`filter`（已选的只看，可取消）、`filterPicker`。前面的段是按钮，当前段与“选择…”用现有的 `Select`（已有分组、说明、八项以上自动搜索）。`nav` 加有序列表，分隔符对读屏隐藏；窄屏换行。样式 `.scope-bar*` |
| `FE/components/SortHeaderCell.tsx`（新） | 可排序的表头单元格，只在当前排序列上写 `aria-sort`，内部是按钮并读出方向；配一个纯函数 `nextSort`。样式 `.data-table__sort*` |
| `FE/components/ExecutionSwimlane.tsx`（扩展） | 每行由一条改为多段：`segments`（起止、填充、是执行还是等待、是否失败、是否未结束、读屏文本与详情）；刻度由调用方给格式化函数，不再固定为“+N 秒”。每段是按钮，焦点或指针移上去时在读数区显示详情；失败用不靠颜色的标记；另有一张等价的数据表。样式并入 `styles.css` |
| `FE/components/ColumnChart.tsx`（扩展） | 值可以为空（画成缺口而不是 0）；可以带 `parts` 画堆叠 |
| `FE/components/MetricTile.tsx`（扩展） | 可选的 `link`，渲染成卡片底部的真链接 |
| `FE/components/SegmentedBar.tsx` 的填充 | 增加 `wait`（斜纹），样式 `.viz-fill--wait` |

不新建的：时间行用现有的 `Segmented`、`FilterBar`、`TextInput`；翻页用现有的 `Pagination`；“按…看”的维度切换用卡片动作区里的 `Select`；当前条用紧凑的指标卡加链接；可点击的行用现有的 `.data-table__row` 与 `shouldRowNavigate`，名称单元格里放真链接；对比不需要新的卡片。

### 9.4 数据

- 查询键都放在 `['observability', 'stats', …]` 下。现在统计的根键是价格键的前缀（`FE/components/observability/observationClient.ts:22-23`），刷新统计会连带重读价格，这次分开。
- `summary` 在页面壳里取一次，六个面共用；换面不发请求，换“按…看”的维度也不发请求。
- `anchor` 保存在页面状态里，只在打开页面、换时间范围、点刷新时更新为当时的时间（proposal §5.9）；统计类查询不设过期。
- `live` 每 30 秒重取，只在概况、人工介入、稳定性三个面、并且没有“只看”运行内部切面时启用，页面不可见时暂停。单个单元与它的调用表在单元未结束时每 30 秒重取（沿用 `ObservationTaskDetail.tsx:51-54` 的规则）。
- 切换范围时不显示上一个范围的数据：只有响应里回显的范围与请求一致时才沿用旧数据（推广 `ProcessSubject.tsx:89-91`）。
- 状态用现有组件：加载 `LoadingState`，出错 `ErrorBanner`（可重试），时间范围内没有数据 `EmptyState`（当前条仍显示），不适用与找不到对象 `NoticeBanner`。
- “只看”的选择器列出的是当前 `summary.breakdowns` 里出现过的值，所以只会选到这个范围和时间里真实存在的 Agent、模型、来源。

### 9.5 文案与格式

- 一份文案 `FE/i18n/observation.ts`（中文、类型、英文），取代 `runObservability.ts` 与 `processMetrics.ts`，在 `zh-CN.ts` 与 `en-US.ts` 里各注册一次。结构按 proposal §7 的词表组织，指标的名称与说明按指标 ID 建一份字典，指标卡、表头、变化图的选项共用同一个名字。
- 其它文件里要改的标签（AC-11 的范围）：节点抽屉统计页签的四个 Token 标签、执行原因的标签、“耗时”；任务详情页节点运行表的“耗时”表头；三个原有入口的标签与提示语。设置页用到的 `builtinRuntime` 移到价格的文案文件。设置页文本主题分析的说明（`FE/i18n/zh-CN.ts:9629-9646` 与英文的对应处）改用新的页面名与面的名字。交办页与任务列表不改文案。
- 一个格式化模块 `observationFormat.ts`：收进 `processFormat.ts` 的百分比、小数、计数、Token 缩写、成本、时长与分位数、时间拆分；保留时间范围与调用成本；新增完整数字。变化的写法改为比率给百分点、其余给百分比，好坏方向取 `OBSERVATION_METRIC_BETTER`。

### 9.6 入口

| 入口 | 位置 | 目标 |
| --- | --- | --- |
| 工作流编辑页（改名） | `FE/routes/workflows.edit.tsx:1260-1270` | 这个工作流 |
| 工作组详情（改名） | `FE/routes/workgroups.detail.tsx:964-975` | 这个工作组 |
| 数字员工卡片（改名） | `FE/routes/digital-employees.$typeRef.tsx:4305-4313` | 这个数字员工 |
| 任务详情页（新） | `FE/routes/tasks.detail.tsx:657-660` 的页头动作区 | 这个任务；内部宿主任务（带交办 ID、类型是数字员工）时是那次交办 |
| 交办页（新） | `FE/routes/employee-cases.$caseId.tsx:845-874` | 这次交办 |
| 节点抽屉的统计页签（新） | `FE/components/NodeDetailDrawer.tsx:356-367`，新增可选属性 | 由任务详情页传入时：这个任务，只看这个环节，明细；内部宿主任务时是交办，不带只看。由工作组任务房间传入时：这个任务，不带只看 |
| Agent 页（新） | `FE/routes/agents.detail.tsx:238-276` | 全部，只看这个 Agent |

门与相邻入口一致：`usePermission('tasks:read')`，任务详情页用页面已有的权限快照。任务类型由现有的 `taskExecutionKind`（`SH/schemas/task.ts:728-743`）得出；代码检视任务不显示入口。

“去处理”的目标：评审到评审页，反问到任务详情页的反问区，工作组的确认与交付到任务房间，外部审批与阻塞到交办页。用各页面现有的路由与页签参数，不新增路由。

## 10. 删除清单

| 位置 | 删除 |
| --- | --- |
| 后端 | `RO/application/observationQueries.ts`（旧）、`RO/application/ports/taskFacts.ts`、`RO/application/process/processQueries.ts`、`TE/infrastructure/taskObservationFacts.ts`、`TE/composition/taskObservationFacts.ts`、`RO/public/queries.ts` 里任务事实端口的导出、调用存储的 `taskCalls`、`recentCalls` 与 `usageByNodeRun` |
| 共享 | `SH/schemas/observation.ts` 里的时间范围查询、任务页、系统查询与总览、任务、Agent、模型、系统执行的响应类型；`SH/schemas/processMetrics.ts` 里的能力列表、汇总查询、单元分页的查询与响应、`PROCESS_HINT_TARGETS` |
| 前端 | §9.2 表里标为删除的文件 |
| 后端测试 | `rfc371-v2-observation-http.test.ts`、`rfc371-v2-observation-queries.test.ts`、`rfc616-process-http.test.ts`、`rfc616-process-queries.test.ts`（场景改写进新的用例文件） |
| 前端测试 | `rfc371-v2-run-observability.test.tsx`、`rfc616-process-metrics-page.test.tsx`、`rfc371-v2-observation-layout.test.ts`、`rfc616-process-entry-links.test.tsx`（场景改写进新的用例文件） |

要跟着改的用例、助手、账本与守卫：

- 后端用例与助手：`rfc371-v2-observation-store.test.ts`、`rfc616-process-assembled.test.ts`、`rfc616-process-stores.test.ts`、`rfc616-process-task-facts.test.ts`、`rfc616-process-kinds.test.ts`、`module-contract-run-observability.test.ts`、`helpers/processMetricsFakes.ts`；`rfc395-q1-dto-parity.test.ts` 与 `helpers/rfc395Q1Parity/compare.ts`（对比面里有被删的任务下钻路由）；`rfc395-run-mint-identities.test.ts:369` 与 `rfc395-w2fix-nb-regressions.test.ts:549-555`（用了被删的 `attempts()`，改用节点执行的事实读取）。
- 后端账本与守卫：`packages/backend/tests/architecture/rfc319-endpoint-coverage.test.ts:52-70`、`rfc329McpSurfaceLedger.ts:172-233`、`packages/backend/tests/contracts/registry.ts:943-1140`、`rfc390-neutral-http-binding.test.ts:29`、`rfc616-process-metrics-boundaries.test.ts:34-44`。
- 前端用例与助手：`rfc371-execution-swimlane-layout.test.tsx`、`rfc616-process-format.test.ts`、`rfc371-v2-observation-format.test.ts`、`rfc616-chart-primitives.test.tsx`、`rfc616-heat.helpers.ts`、`rfc616-settings-process-insight.test.tsx:456`、`tab-callsite-contract.test.ts:168-170`、`route-ux-inventory.test.ts:552-557`。
- 端到端与 CI：`e2e/rfc371-run-observability.spec.ts`、`e2e/process-metrics.spec.ts`、`e2e/a11y.spec.ts:471-495`、`.github/e2e-test-timings.json` 里对应的条目。

## 11. 失败模式

| 情况 | 处理 |
| --- | --- |
| 范围里的单元超过上限 | 只装配最近的 2,000 个，`note.partial` 为真，页面顶部说明 |
| 未结束的单元超过上限 | 运行中、等人处理的个数与还在等的人工门都只来自最近的 500 个；已中断同样最多 500 个。响应标明截断，页面注明 |
| 未解决的告警超过 50 条 | 列出最近的 50 条并给出总数 |
| 时间范围内有调用的任务超过 20,000（期间实际消耗） | 沿用现有的 `partial` 标记，卡上注明只统计了一部分 |
| 能力、任务、交办不存在或不可见 | 404，与不存在同形；页面显示提示与通向上一层的链接 |
| 单元是数字员工的内部宿主任务 | 409 加交办引用，页面跳到交办 |
| “只看”在当前位置不可用，或接口不支持这种切面 | 422；前端的地址校验已经丢掉这类参数，并且不发这类请求 |
| 自定义的起止时间无效 | 前端在时间行里提示并保留原来的范围；地址里的无效值回到近 30 天；服务端对无效的时间范围返回 422 |
| 能力已删除 | 仍按 ID 汇总，名称显示“已删除的…”，没有通向它页面的链接 |
| 某个单元的定义快照损坏 | 沿用现有做法：逐字段读取，一个损坏的文档不让整批失败，该单元的环节归到“未归属” |
| 调用没有定价、用量不完整 | 沿用现有标记：成本是下界，Token 是下界 |
| 汇总请求进行中用户换了范围 | 旧请求的结果因回显的范围不一致而被丢弃 |
| 文本主题分析对单代理 | 不提供，卡片不出现 |

## 12. 性能与上限

- 所有按 ID 的读取仍然每批 500 个，块与块之间让出事件循环（`RO/application/process/sources.ts:56-70`）。期间实际消耗里按任务集合的聚合也改成这种分块，不再用不让出的循环。
- 能查看全部任务的账号，首屏从约五条聚合变成一次完整深度的装配。上限时是 2,000 个单元，三个装配器各约 4 块乘 14 条查询，再加人工门的 JSON 解析；开对比时再装配一次。只能查看自己任务的账号，可见性现在在取单元的 SQL 里判定，不再先取两万个任务 ID 再分块核对。
- 需要留意的查询：`activeUnits`（状态的 IN 列表，走 `idx_tasks_list_status_started_id`）；`callSlices` 与 `modelSlices`（分组里有表达式，PostgreSQL 要在 GROUP BY 里重复）；明细按成本排序（对全部行做列表深度的装配）。
- 目标：2,000 个单元的范围，本机 SQLite 上 `summary` 在 2 秒内返回，`live` 在 1 秒内返回（proposal AC-18）。集中验证阶段用 2,000 个单元的夹具实测；达不到时把上限调到能达到的值，并在交付计划里记录（RFC-616 同样的处置）。
- 不做结果缓存，不自动轮询汇总。

## 13. 测试策略

### 13.1 后端

| 层 | 必写的用例 |
| --- | --- |
| 共享定义 | 请求的解析；`observationOnlyAllowed` 对 proposal §4.3 整张表；两个分段函数在各个临界长度上的取值，以及四个快捷项的结果；模型键的编码与解码（运行时键与模型名里含冒号、斜杠）；提示到关注面的映射穷尽 14 个 ID |
| 纯函数（`domain/process`） | 五类状态与成功率的分母；已中断的任务总历时算到现在；单元的用量只含自己的、`invoked` 不进任何合计；人工介入次数不含继承副本，时间拆分的等人含；`restrictToPart` 对普通环节、包装器与另外四种只看各自留下什么；度量的可加性（各维度的行加“其余”等于合计；“Token 花在哪里”六项之和等于合计；全部等于各类型之和、类型等于各能力之和、能力等于各单元之和）；按模型时次数不可加而 Token 与成本可加；已有只看时运行内部维度的行标为不可点；分段的边界、时区偏移与周一对齐；对比的方向；提示的挑选（每个能力一条、每种一条、共四条；单代理只开通用规则；跨能力时与能力自己的范围结果相同） |
| 调用存储（两种数据库） | `callSlices` 各组之和等于按任务的合计；`modelSlices` 的 Token 与成本之和等于调用合计，多模型的调用在每个模型下各算一次；Agent 键与模型的过滤；没有任务的调用；按小时、3 小时、天分桶；`callsOf` 先过滤再截取、按节点执行 ID 过滤、分页与总数 |
| 事实（两种数据库） | `units` 取三种类型（含单代理）、带上限；`activeUnits` 不含已中断并给出已中断的个数；`lineage` 的类型、来源能力、交办、可见、已删除；`unit` 对内部宿主任务指向交办、对当工具用的工作流任务正常返回；`reactionHostTasks` 带主体类型；`activeUnits` 的两种 `phase` 各自返回行；`activeCases`、`casesOfRounds`；`ProcessAlertFacts` 三个方法与总数 |
| 装配（两种数据库） | 有调用节点时：被调起的任务只算在自己的能力里，父任务的成本不含它，父任务的 `invoked` 等于它的成本，全部的合计不重复；被调起的工作组的完成确认在“全部”里算得到且只算一次；同一个能力嵌套调用时各行相加仍等于合计；单代理能力的汇总（含反问）；平台调用的汇总，以及它在“全部”各维度里的那一行；期间实际消耗、来自更早开始的部分、已删除任务的一行计入合计；数字员工把工作流当工具时，那个任务只算在工作流名下，交办的成本与评审不含它、`invoked` 含它、等人时间含它；调用节点那一行的 `invoked` 等于子任务的成本；多个工作流同在一个范围时各用自己的定义（循环上限、环节名）；`live` 里父任务在跑、子任务在等评审时各算一个，等的那一轮只列一次；已中断的列表与个数一致；只看反问环节时调用表含按时间归到它的追问调用，只看执行原因为系统工作时含没有节点执行的系统调用；平台调用表的页码与总数 |
| 路由 | 门与可见范围；按人的字段对只能查看自己任务的账号不返回；只看的可用性与不支持的切面返回 422；找不到返回 404；内部宿主任务返回 409；无效的时间范围返回 422；旧路由不存在 |
| 架构守卫 | 事实合同的实现方清单；合同文件仍只有类型与两个常量；run-observability 不 import 拥有方；归属债不增加 |
| 性能 | 2,000 个单元的夹具：`summary` 与 `live` 的耗时 |

### 13.2 前端

| 层 | 必写的用例 |
| --- | --- |
| 纯函数 | 地址校验（默认值、逐字段、位置与只看的可用性、自定义范围的有效与无效、不认识的旧参数被忽略而同名的按新规则校验）；三个跳转函数与回顶规则；`observationWindow` 对快捷项与自定义，整个范围在将来时回到近 30 天；`customRangeOf`（结束不晚于开始、超过最长、结束晚于现在）；链接函数对各个入口的输出，并能原样通过校验；`aspectSpec`（每个面每种粒度每种类型的卡不超过六张、列与 proposal §5.3 一致、可用维度、着色指标）；格式化（缩写与完整数字、三种时长形式、没有样本是“—”不是 0、“¥x 起”与“未定价”、百分点与百分比、好坏方向）；`nextSort` |
| 公共组件 | 范围条（角色、选择、取消只看、窄屏换行）；可排序表头（`aria-sort`、切换）；时间轴（并行的执行、未结束、等待的斜纹、失败的标记、数据表）；柱图（堆叠之和、缺口不是 0）；指标卡的链接 |
| 页面（按角色查询） | 七个页签；换面与换维度不重取汇总（数请求次数）；点一行收窄范围；已有只看时运行内部维度的行不可点、位置类的行可点并保留只看；取消只看；自定义时间范围的应用、出错提示与回到快捷项；平台调用下质量与人工介入显示不适用；30 秒轮询只在指定的面与未结束的单元（假时钟）；刷新更新截至时间；只能查看自己任务的账号没有发起人与处理人、等谁处理显示“任务成员”；明细的搜索、七项状态、排序、列集与页码 |
| 入口与叫法 | 各入口文件各恰好一处 `observationLink(`、标签的文案键、门；源码守卫：被替换的旧叫法不出现在观测文案、节点抽屉与节点运行表的文案和入口文件里，没有 `processMetricsLink`、没有对 `process-metrics/` 的引用 |
| 端到端 | 四个问题各一条：从工作流编辑页进入能力概况，经提升点到人工介入；从任务详情页进入全过程，再看成本；从全部的成本逐级钻到环节，每层表尾合计等于成本卡，上一层那一行等于下一层的成本卡；从人工介入的现在在等谁进入单元，到“去处理”。另加自定义时间范围、Agent 页与节点抽屉两个入口、无障碍扫描（七个面在全部、能力、单元三种范围，亮色桌面与暗色窄屏）、权限 |

回归防护的文件名带 `rfc630-` 前缀，文件顶端写明锁的是哪一条（例如“被调起的任务只算在它自己的能力里”）。

## 14. 待核实项

以下各条在实现时先核实，结论记入交付计划：

1. 调用账本里的 Agent ID 与 Agent 页面路由用的 ID 是否同一个；不是的话 Agent 页的入口改用名称键。
2. 明细按成本排序在上限时的耗时；过慢时把这种排序限制在最近的 500 个并注明。
3. 父任务的自动执行已经扣掉的“调用节点等子任务里的人处理的时间”具体含哪些等待；与 proposal §6.2 第 3 条的说法对一遍。
4. 工作组任务房间里的节点抽屉能拿到哪些标识。

## 15. 设计门记录

设计门由本 session 派生的 subagent 执行，只审功能。

### 15.1 第 1 轮（2026-11-27）：不通过

没有 P0，11 条 P1，20 条 P2。处置如下。

| 发现 | 处置 |
| --- | --- |
| P1-1 子孙的用量按调用节点的原因归类，跨能力范围里按执行原因看对不上 | 换归属规则：每个任务只算在它自己的能力里，单元的用量只含自己的（§5.1、§5.2，proposal §6.2） |
| P1-2 同一个能力嵌套调用时各行重复计 | 同上，不再有折进来的子孙用量 |
| P1-3 类型一级只算根、进入能力后算全部，逐层对不上；只被调起的能力从表里消失 | 同上，每一层都是同一批单元 |
| P1-4 数字员工调用不满足“算进发起方”；被调起的工作组的人工门等待不完整 | 同上：不再承诺算进发起方；交办沿用现有的按轮统计；时间拆分的限制写进 proposal §6.2 第 3 条 |
| P1-5 数字员工当工具用的工作流任务被跳到交办，自己的全过程到不了 | 只有内部宿主任务跳到交办；当工具用的工作流任务是工作流的单元（§7） |
| P1-6 “当前”的计数口径没有定义 | 每个未结束的单元算一个，有未处理人工门的算等人处理，每一轮只列一次；上限与计数的说法统一（§7、§11，proposal §5.5） |
| P1-7 已有只看时点一行会换掉只看，数字跳变 | 位置类的行保留只看；其它维度的行在已有只看时不可点（proposal §4.3，§5.5） |
| P1-8 只看模型、Agent、系统工作时若干指标算不出，两种失败率同名 | 模型切片补上调用数、失败、时长；失败码取所在执行的；两种失败率分开命名（§4.2、§6，proposal §8.2） |
| P1-9 指标卡不超过六张与工作组的卡数矛盾 | 类型特有的数字放进特有的卡（proposal §5.3） |
| P1-10 方案确认的结果、类型特有的列、包装器的历时没有去处 | 各补上位置；只看包装器有了定义（proposal §5.3、§10，§5.4、§5.5） |
| P1-11 若干口径变化没有列出 | 逐条列进 proposal §8.3 与 §11；行数上限改为 200 |
| P2 的 20 条 | 平台调用在各维度里单独成行、不提供按发起人看；部分粒度不显示此刻的数字；告警的上限与总数；运行内部维度用部分粒度的列；单代理可以有反问、适用哪些提示规则；周一对齐与已删除一行计入合计；旧参数的说法；翻页用现有的页码组件，不新增游标翻页；工作组房间的节点抽屉；删改清单补全；`taskUnits.ts:58`；第几次执行的来源；“其余”的截取标准；AC-11 的范围；调用表先过滤再截取；单元接口返回同样的分组；模型键的编码；两条待核实项已由检视确认。逐条落在本文与 proposal 的对应位置 |

同一轮里并入了用户追加的要求：时间范围可以自定义，四个固定范围作为快捷项（proposal §5.1、AC-23，§4.1、§9.1、§9.2）。

### 15.2 第 2 轮（2026-11-27）：不通过

没有 P0，3 条 P1，14 条 P2。检视确认新的归属规则自洽、按现有引擎可以实现，自定义时间范围的设计完整。处置如下。

| 发现 | 处置 |
| --- | --- |
| P1-A 数字员工当工具用的工作流任务被交办与工作流同时计入 | 宿主任务的事实行带主体类型；数字员工装配器只折入内部宿主任务；当工具用的工作流任务在交办里只作继承副本并进 `invoked`（§3.2、§5.2）；对交办数字的影响列进 proposal §8.3 |
| P1-B 明细的“已中断”取不到列表 | `activeUnits` 按 `phase` 分别返回未结束的行与已中断的行，计数来自取到的行（§3.2、§7） |
| P1-C 调用节点那一行的子任务花费看不到了 | `invoked` 按调起它的环节拆分，成本面按环节看时调用节点那一行多一列，不计入合计（§5.2，proposal §5.3、§8.3） |
| P2 的 14 条 | 多能力的范围按能力分组装配；继承来的人工门轮次在单元里标明后列出；等人处理的判定统一为“状态是等待，或有未处理的人工门”；`activeUnits` 的过滤与计数；调用表补上追问调用与没有节点执行的系统调用，平台调用表也用 `callsOf`；未结束列表的上限写进 proposal；设置页的说明与用例；目标里去掉交办页；归属的开头限定为统计；整个范围在将来时回到近 30 天；可加性在没有截断时成立；只看包装器的定义；数量的统计对象变化列进 proposal §8.3。逐条落在本文与 proposal 的对应位置 |
