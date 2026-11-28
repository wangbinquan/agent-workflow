# RFC-630 交付计划：运行观测按领域模型重排

配套：[产品方案](./proposal.md) · [技术设计](./design.md) · [页面原型](./prototype/index.html)

- 状态：Draft（2026-11-27）。用户批准之前不写实现代码。

## 1. 交付方式

- 一个 RFC，一次交付。后端的读模型、共享定义、前端页面三部分互相依赖，拆开会留下“新页面缺数据”或“两套页面并存”的中间态，所以不分期。
- 按仓库的硬规则：先完成全部生产实现、接线和测试用例，再集中执行验证；开发期间只做读码与语法、格式的静态自查。
- 直接在 `main` 上提交。提交按路径清单精确暂存；共享账本（`design/plan.md`、`STATE.md`）只带本 RFC 的行。
- 实现完成后跑实现门（本 session 派生的 subagent，只审功能），再推送并按确切提交跟踪 CI。

## 2. 任务分解

### 2.1 共享定义

| 编号 | 任务 | 主要文件 | 用例 |
| --- | --- | --- | --- |
| T1 | 新的共享定义：类型、关注面、只看的种类、维度、五类状态、分段、上限、范围与只看的参数、`observationOnlyAllowed`、一组度量、各接口的请求与响应、提示到关注面的映射、指标的好坏方向 | `packages/shared/src/schemas/observability.ts`（新）、`packages/shared/src/index.ts` | 解析与校验；可用性整表；映射穷尽 |
| T2 | 精简旧定义：`observation.ts` 只留调用状态、时间范围上限、价格、人民币格式化；`processMetrics.ts` 只留三类能力、人工门与提示的定义；`ProcessUnitStatus` 加 `interrupted` | `packages/shared/src/schemas/observation.ts`、`processMetrics.ts` | 现有共享用例随之调整 |

### 2.2 后端

| 编号 | 任务 | 主要文件 | 用例 |
| --- | --- | --- | --- |
| T3 | 事实合同：`units` 的 `kinds` 与 `roots`、`activeUnits`、`unit` 接受单代理并指向交办、`lineage`、`activeCases`、`casesOfRounds`、新的 `ProcessAlertFacts` | `packages/backend/src/platform/contracts/processFacts.ts` | 边界守卫更新（实现方清单、合同文件只有类型与两个常量） |
| T4 | task-execution 的事实实现 | `packages/backend/src/modules/task-execution/infrastructure/processTaskFacts.ts` | 两种数据库：单代理、只取根、未结束、已中断的个数、谱系与根的回退、可见与已删除、宿主任务指向交办 |
| T5 | digital-employee 的事实实现 | `packages/backend/src/modules/digital-employee/infrastructure/processEmployeeFacts.ts` | 两种数据库：未结束的交办、由轮查交办 |
| T6 | system-operations 的告警事实与装配工厂 | `packages/backend/src/modules/system-operations/infrastructure/processAlertFacts.ts`（新）、`composition/processAlertFacts.ts`（新） | 两种数据库：三个方法；归属债不增加 |
| T7 | 调用存储：`callSlices`、`modelSlices`、Agent 键与无任务的过滤、`aggregateModels` 的分组与过滤、分桶宽度参数、`callsOfTasks` | `packages/backend/src/modules/run-observability/application/ports/callStore.ts`、`infrastructure/callPersistence.ts` | 两种数据库：切片之和等于合计、过滤、分桶、上限 |
| T8 | 领域：范围与根、限制到部分、一组度量、按维度分组、分段、五类状态、合计口径的“Token 花在哪里”、提示的挑选 | `packages/backend/src/modules/run-observability/domain/process/`（`scope.ts`、`parts.ts`、`measures.ts`、`breakdown.ts`、`buckets.ts` 新；`model.ts`、`unitSummary.ts`、`stageSummary.ts`、`gateSummary.ts`、`hints.ts` 改） | 纯函数用例（design §13.1 第二行） |
| T9 | 装配器：执行的起止与 Agent、调用切片进单元事实、单代理走工作流装配器、各能力的目录 | `packages/backend/src/modules/run-observability/application/process/sources.ts`、`kinds/taskUnits.ts`、`kinds/workflow.ts`、`kinds/workgroup.ts`、`kinds/employee.ts` | 扩展 `rfc616-process-kinds`；新增单代理的用例 |
| T10 | 应用层：范围装配、八个用例、期间实际消耗、当前 | `packages/backend/src/modules/run-observability/application/process/scopeLoader.ts`、`observationQueries.ts`、`actualSpend.ts`、`liveState.ts`（新） | 用假事实的查询用例；两种数据库的装配用例（design §13.1 第五行） |
| T11 | 路由：八条新路由；价格路由移到单独文件；删除被替换的十条 | `packages/backend/src/modules/run-observability/inbound/http/observabilityRoutes.ts`（新）、`pricingRoutes.ts`（新）、`observationRoutes.ts`、`processRoutes.ts` | 路由用例（门、可见范围、422、404、409、旧路由不存在） |
| T12 | 装配与启动：合并两份装配，绑定告警事实，去掉任务事实端口 | `packages/backend/src/modules/run-observability/composition/`、`packages/backend/src/bootstrap/daemonHttpComposition.ts` | `module-contract-run-observability`、`rfc390-neutral-http-binding` 改写 |
| T13 | 删除与账本：design §10 的后端与共享部分；端点覆盖、MCP 面、合同登记、`rfc395` 两处改用别的读取 | design §10 列出的文件 | 守卫与账本用例通过新的清单 |
| T14 | 性能夹具：2,000 个单元 | `packages/backend/tests/` 下新的夹具与用例 | `summary` 2 秒内、`live` 1 秒内（本机 SQLite） |

### 2.3 前端

| 编号 | 任务 | 主要文件 | 用例 |
| --- | --- | --- | --- |
| T15 | 公共组件：范围条、可排序表头、游标翻页移入；时间轴、柱图、指标卡、填充色的扩展 | `packages/frontend/src/components/ScopeBar.tsx`、`SortHeaderCell.tsx`、`CursorPager.tsx`（新）；`ExecutionSwimlane.tsx`、`ColumnChart.tsx`、`MetricTile.tsx`、`SegmentedBar.tsx`、`styles.css` | 各组件的单测（design §13.2 第二行） |
| T16 | 文案：一份观测文案（中英），注册；其它文件里的叫法 | `packages/frontend/src/i18n/observation.ts`（新）、`zh-CN.ts`、`en-US.ts`、`observationPricing.ts` | 中英键一致；文案键可解析 |
| T17 | 格式化合并 | `packages/frontend/src/components/observability/observationFormat.ts` | 格式用例 |
| T18 | 地址与链接 | `packages/frontend/src/components/observability/observationSearch.ts`（新）、`packages/frontend/src/routes/observability.tsx` | 校验、跳转、回顶、链接 |
| T19 | 数据层：客户端、查询键、时间范围的终点、各查询的钩子 | `packages/frontend/src/components/observability/observationClient.ts`、新的钩子文件 | 请求次数与定时器 |
| T20 | 页面壳：页头、范围条、时间行、页签、数据说明、各种状态 | `packages/frontend/src/components/observability/ObservationPage.tsx` 等（新） | 页面用例 |
| T21 | `aspectSpec` 与汇总的各卡：指标卡、构成、变化、按…看、当前条、现在在等谁、告警、提升点、期间实际消耗 | `packages/frontend/src/components/observability/` 下新文件 | `aspectSpec` 的纯函数用例；各卡的组件用例 |
| T22 | 单个能力的卡：环节一览（画布、职责图、成员表）、按轮次、人工门的细项、评审的结果、文本主题分析、稳定性的次数 | 由 `process-metrics/` 下的文件拆分、移入 | 沿用并改写现有的画布热力、职责图热力用例 |
| T23 | 明细：单元表（三种列集、搜索、筛选、排序、翻页）与调用表 | `packages/frontend/src/components/observability/` 下新文件 | 组件用例 |
| T24 | 单个任务或交办：基本情况、七个面、全过程、人工门的每一轮、操作、告警、恢复记录、调用表、30 秒刷新 | 同上 | 组件用例 |
| T25 | 入口：三个改名、四个新增、节点抽屉的新属性 | `packages/frontend/src/routes/workflows.edit.tsx`、`workgroups.detail.tsx`、`digital-employees.$typeRef.tsx`、`tasks.detail.tsx`、`employee-cases.$caseId.tsx`、`agents.detail.tsx`、`packages/frontend/src/components/NodeDetailDrawer.tsx` | 入口与叫法的守卫 |
| T26 | 删除旧文件与样式，`.process-metrics*` 改名，更新页签、路由、图表的清单类守卫 | design §9.2、§10 | 守卫通过 |
| T27 | 端到端：四个问题、两个新入口、无障碍、权限；改写两份旧的规格 | `e2e/rfc630-observability.spec.ts`（新）、`e2e/rfc371-run-observability.spec.ts`、`e2e/process-metrics.spec.ts`、`e2e/a11y.spec.ts` | 即这些规格 |

### 2.4 文档

| 编号 | 任务 |
| --- | --- |
| T28 | 把原型里与方案不一致的地方记在 proposal §15（已写）；实现完成后在本文件 §6 记录实现与设计的出入、验证结果与 CI 证据 |
| T29 | `design/plan.md` 的索引与 `STATE.md` 的条目；通用的踩坑记入 `docs/dev-gotchas.md` |

## 3. 依赖与顺序

```text
T1 → T2
T1 → T3 → T4, T5, T6
T1 → T7
T3, T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14
T1 → T15, T16, T17, T18
T1, T18 → T19 → T20 → T21 → T22, T23, T24
T18 → T25
T20–T25 → T26 → T27
```

- T1 是前后端的共同起点：请求与响应的形状定下来之后，后端与前端可以各自推进。
- 后端的 T4、T5、T6、T7 互不依赖；前端的 T15、T16、T17、T18 互不依赖。
- 删除（T13、T26）放在各自一侧的最后，在新代码接好之后做。

## 4. 验证计划

全部任务与用例写完之后，一次集中验证：

1. 静态：类型检查、lint（零警告）、格式。
2. 后端：本 RFC 新增与改动的用例文件；相关的架构守卫；然后是 SQLite 上的完整后端用例。PostgreSQL 一侧以 CI 为准，本机负载允许时先跑涉及两种数据库的那些文件。
3. 共享与前端的单测。
4. 性能：2,000 个单元的夹具实测 `summary` 与 `live`。
5. 端到端与视觉对齐：本地起服务，用带数据的实例走一遍四个问题，并与 `/tasks`、`/workflows`、`/agents`、`/settings` 并排比对控件的高度、圆角、间距、字号。
6. 对账：同一份数据上，新页面“全部 › 成本”的期间实际消耗与旧总览的期间 Token、成本相等（改之前先记下旧数字）；单个能力的各项指标与旧过程度量逐项相等，§8.3 列出的口径变化除外。
7. 实现门（subagent，只审功能），处置发现，复验受影响的范围。
8. 提交、推送，按确切提交跟踪 CI；红了先归因。

第 6 步是这次改造特有的：读模型从两套并成一套，对账是防止数字被悄悄改掉的主要手段。旧数字在删除旧路由之前取得并存档。

## 5. 验收清单

| 验收标准 | 证据 |
| --- | --- |
| AC-1、AC-2、AC-3 | 地址校验与跳转的纯函数用例；页面用例；端到端 |
| AC-4 | `aspectSpec` 的用例；页面用例里对平台调用的不适用 |
| AC-5 | 时间轴的组件用例；单元视图的组件用例；端到端 |
| AC-6、AC-7 | 领域的可加性与归属用例；两种数据库的装配用例；端到端里逐层比对合计 |
| AC-8 | 期间实际消耗的装配用例；对账（§4 第 6 步） |
| AC-9 | `live` 的装配与路由用例；页面用例里的定时器与“任务成员” |
| AC-10 | 单代理与平台调用的装配用例 |
| AC-11 | 叫法的源码守卫 |
| AC-12 | 装配用例：同一个任务在三处的总历时、成本、状态相同 |
| AC-13 | 入口的守卫；端到端 |
| AC-14 | 提示挑选的纯函数用例；映射穷尽的用例 |
| AC-15 | 对比的纯函数用例；格式用例 |
| AC-16 | 路由用例；页面用例 |
| AC-17 | proposal §10 逐行对照的检查表（实现门时由 subagent 对照源码核一遍） |
| AC-18 | 性能夹具 |
| AC-19 | 端到端的无障碍与窄屏；组件用例 |
| AC-20 | 地址校验的用例；页面用例 |
| AC-21 | 单元表的组件用例；`units` 的路由用例 |
| AC-22 | 数据层的用例 |

## 6. 记录

（实现后填写：实现与设计的出入、待核实项的结论、验证结果、对账结果、CI 证据。）
