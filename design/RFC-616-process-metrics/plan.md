# RFC-616 交付计划：过程度量

> 状态：In Progress，2026-11-26 用户批准（设计门后修订稿）。产品口径见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
> 用户 2026-11-26 确定“一个 RFC，一次交付”：全部生产实现、接线和测试用例写完之后，再集中执行验证、实现门和发布。开发期间只做读码、语法与格式的静态自查。

## 0. 约束

1. 只在 `main` 上开发，不建分支、不用 worktree、不用 stash；提交按明确的路径清单，带 pathspec。
2. 先完成全部开发和用例编写，再集中验证；不把需求拆成小批反复跑测试。
3. 结构历史不可改写：两张新表的结构版本（T23）放在表结构定稿之后、集中验证之前生成。
4. 门检视只审功能。
5. design §15 的十一条待核实项，在动到对应代码之前先对源码复核；与设计不符时先改设计文档并在本文件记录。

## 1. 任务

### A. 共享合同与领域

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T1 | 执行原因归类表；过程度量的查询与响应合同、提示规则标识、可观测动作的闭集 | `packages/shared/src/processCause.ts`、`packages/shared/src/schemas/processMetrics.ts`、`index.ts` 导出；用例 |
| T2 | 度量引擎的纯函数：统计与排名分档、时间拆分、执行原因的归类与改判、阶段目录、单元汇总、阶段聚合、人工门聚合、趋势、两段对比、提示规则、文本主题计数 | `run-observability/domain/process/*`；用例 |

### B. 事实合同与实现

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T3 | 中立的事实合同（五个接口与各事实行的类型）；本模块自己的端口（人的操作存储、分析存储、分析运行器、身份目录、工作流名称） | `packages/backend/src/platform/contracts/processFacts.ts`、`run-observability/application/process/ports/*` |
| T4 | 任务事实：单元、任务概要、子孙任务、执行聚合（带原始重跑原因）、包装器、节点执行归属、冻结定义、轮次到宿主任务、单任务区间；自动执行时长用既有的有效运行时长 | `task-execution/infrastructure/processTaskFacts.ts`、`composition/processFacts.ts`；双库用例 |
| T5 | 工作组：把宿主执行到成员的归属规则提到 shared，房间投影改用它且输出不变；工作组事实（名单、派单、交付、停驻行与轮次、完成确认的决定、活动、原文） | `packages/shared/src/workgroupHostRun.ts`、`resource-catalog/application/workgroups/workgroupRoomProjection.ts`、`task-execution/infrastructure/processWorkgroupFacts.ts`；归属规则用例、房间投影回归用例、双库用例 |
| T6 | 人工门事实：评审与反问轮次及数值（含作废、实例内序号）、原文 | `collaboration/infrastructure/processGateFacts.ts`、`composition/processFacts.ts`；双库用例 |
| T7 | 数字员工事实；类型包的两个可选成员 `describeProcessMetricsJson`（返工类工作项）与 `projectHumanFeedbackJson`（人提的反馈），研发类型实现 | `digital-employee/infrastructure/processEmployeeFacts.ts`、`composition/processFacts.ts`、`digital-employee/public/types.ts`、`development-automation/application/employeeTypePackage.ts`；双库用例 |
| T8 | 事件中心：按主体取事件历史 | `event-center/infrastructure/processSubjectEvents.ts`、`composition/processFacts.ts`；双库用例 |
| T9 | 调用存储的三个只读方法（按节点执行汇总、系统调用切片、最早调用时间） | `run-observability/application/ports/callStore.ts`、`infrastructure/callPersistence.ts`；双库用例 |

### C. 人的操作

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T10 | `RouteMeta.observe`、记录器的类型与挂接函数、登记点的包裹、`sameMeta` 的逐字段比较、登记点的日志 | `packages/backend/src/routes/registry.ts`；HTTP 与 MCP 两种传输的用例 |
| T11 | 记录器与存储，`observation_operations` 的表声明 | `run-observability/application/process/operationObservations.ts`、`infrastructure/operationPersistence.ts`、`infrastructure/persistence/schema.ts`、`public/participants.ts`；双库用例 |
| T12 | 在 design §5.4 列出的 19 条路由上声明 `observe` | 四个模块的 `inbound/http/*Routes.ts`；源码层用例与行为用例 |
| T13 | 装配：`mountApiRoutes` 绑定记录器，带写窗口 | `packages/backend/src/server.ts`、`bootstrap/*` |

### D. 用例与接口

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T14 | 三类能力的装配器；能力列表、能力汇总、单元分页、单元明细；范围、上限、数据说明、按人明细的开关、两段对比 | `run-observability/application/process/kinds/*`、`processQueries.ts`；每类一个覆盖主要路径的夹具用例 |
| T15 | 六条路由、模块装配、装配根绑定各事实实现与端口；路由清单类用例的登记 | `inbound/http/processRoutes.ts`、`composition/processMetrics.ts`、`bootstrap/daemonHttpComposition.ts`；`tests/contracts/registry.ts`、`tests/architecture/rfc329McpSurfaceLedger.ts`、`tests/architecture/rfc319-endpoint-coverage.test.ts`、`architecture/e2e-endpoint-coverage.json`；HTTP 用例 |

### E. 文本主题分析

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T16 | `observation_insight_analyses` 的表声明与存储；受理、执行、读取、定时插入；提示词与校验 | `run-observability/application/process/insightAnalyses.ts`、`infrastructure/insightPersistence.ts`；双库用例、运行器替身用例 |
| T17 | 两个设置项；系统 Agent 运行通道的绑定；后台作业登记 | `packages/shared/src/schemas/config.ts`、`runtime-management` 的运行时引用守卫、`bootstrap/daemonModules/observation.ts`、`bootstrap/daemonLifecycleProgram.ts`、`bootstrap/daemonSession.ts`；`tests/rfc379-daemon-lifecycle.test.ts`、`tests/rfc349-sqlite-daemon-pausable-writers.test.ts`、`tests/rfc380-daemon-module-bundles.test.ts` 的清单更新 |

### F. 前端

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T18 | 图表配色 token；六个公共组件；现有观测总览的指标卡改用 `MetricTile` | `packages/frontend/src/styles.css`、`components/MetricTile.tsx`、`SegmentedBar.tsx`、`MeterBar.tsx`、`ColumnChart.tsx`、`TrendChart.tsx`、`HeatScale.tsx`；组件用例 |
| T19 | 画布的 `nodeHeat`；职责图的 `heat` | `components/canvas/WorkflowCanvas.tsx`、`nodes/types.ts`、`nodes/CanvasNodeCard.tsx`、`components/digital-employees/EmployeeCapabilityPanorama.tsx`；含“未传时不变”的用例 |
| T20 | 过程度量页：客户端、列表、三类详情的全部页签、数据说明、文本主题分析面板、文案、查询参数、近 90 天 | `components/process-metrics/*`、`i18n/processMetrics.ts`、`routes/observability.tsx`、`components/observability/RunObservability.tsx`；页面用例 |
| T21 | 三处入口；设置页两个字段；系统执行类别名 | `routes/workflows.edit.tsx`、`routes/workgroups.detail.tsx`、`routes/digital-employees.$typeRef.tsx`、`routes/settings.tsx`、`lib/settings-drafts.ts`、`i18n/runObservability.ts`；用例 |
| T22 | 端到端用例 | `e2e/process-metrics.spec.ts` |

### G. 结构历史、文档与发布

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| T23 | 两张新表的结构版本（每张表一个 `add-table`）、四个 PostgreSQL 大版本的目录、种子、映射条目、表数量断言、名册、表导出；观测边界守卫的表集合与导入白名单 | design §10.3 所列文件 |
| T24 | 文档：`STATE.md`、`design/plan.md` 索引、`docs/module-contract-testing.md` 的模块行；新踩的通用坑写进 `docs/dev-gotchas.md` | 文档 |
| T25 | 集中验证、实现门、发布、按确切 SHA 跟踪 CI | 本文件 §3、§4 的记录 |

## 2. 依赖与顺序

```text
T1 → T2 → T3 ─┬→ T4 ─┐
              ├→ T5 ─┤
              ├→ T6 ─┤
              ├→ T7 ─┼→ T14 → T15 ─┬→ T20 → T21 → T22 ─┐
              ├→ T8 ─┤             │                    │
              └→ T9 ─┘             │                    ├→ T23 → T24 → T25
T10 → T11 → T12 → T13 ─────────────┤                    │
T16 → T17 ─────────────────────────┘                    │
T18 → T19 ──────────────────────────────→ T20 ──────────┘
```

T4 至 T9 相互独立；T10 至 T13 与 B 组独立；T18、T19 与后端独立。全部在同一棵工作树上顺序完成，不拆 PR。

## 3. 集中验证清单

全部任务的实现与用例写完后一次执行：

1. `bun run typecheck`、`bun run lint`、`bun run format:check`。
2. 后端：本 RFC 新增与改动的用例文件；所有引用了被改文件的既有用例（按 import 关系选出）；架构守卫全集。
3. 共享包与前端的用例全集。
4. `bun run scripts/schema-history.ts --check`。
5. 规模：2,000 个任务的夹具上实测能力汇总的耗时（AC-13）；2,000 次交办、每次 20 轮的夹具上实测数字员工轮次的读取（design §6.3）。后者超出预算时，在本 RFC 内给轮次表补一个按交办的索引（多一个结构版本），并在 §4 记录。
6. 本机起服务，按 proposal §14 的验收标准逐条走一遍三类能力的页面，1280 与 390 宽度、明暗主题。
7. 变异检查：对每组核心规则（执行原因归类与占位行、时间拆分、排名分档、评审作废轮次、会话合并、范围过滤、提示阈值）各做一处人为改错，确认有用例变红。
8. 实现门：按路径限定的独立只读检视，只审功能。

发现本人缺陷后修复，并只复验受影响的范围。

## 4. 记录

### 4.1 已知的并发事项

- RFC-615（另一会话，已于 2026-11-26 转 Done）去掉了“历史行桥对每个结构版本建一座桥”里的重复计算。本 RFC 再加两个版本仍会让该用例变慢；T23 之后在集中验证里看它的耗时，发布后若该用例变红，按文首规则归因。
- T23 需要 PostgreSQL 15、16、17、18 四个大版本的实例来生成目录；本机容器环境不可用时，在本文件记录并在当前会话说明，不用别的方式绕过。

### 4.2 设计门（2026-11-26）

执行方式：独立的只读检视，范围限定在本 RFC 的三份文档与它们引用的源码，只审功能。结论：通过，带十二条发现（F1 为阻断项）。处置如下，全部已写入修订后的文档。

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| F1（阻断） | collaboration、digital-employee、event-center 实现事实端口时要 import run-observability 的公开类型；resource-catalog 与 task-execution 共用归属规则时要互相 import。这些都不在目标依赖图内，守卫会红 | 事实合同移到平台层的中立文件，拥有方只依赖平台合同；归属规则提到 shared（design §3.2、§3.3） |
| F2 | 原设计在平台层新建路径含 `observ` 的文件，并让 run-observability import 它和日志模块，违反观测边界守卫 | 记录器的类型与挂接函数放进路由登记点所在的文件（已在白名单内），日志留在登记点（design §5.4） |
| F3 | 兄弟评审被连带作废时写的是“退回、由系统决定”，会被算成人的退回；轮次序号要按评审实例算 | 作废的轮次只计入等人时间；序号取同一评审节点执行内的有效轮次（design §5.2） |
| F4 | 单元没有包含子孙任务；自动执行时长把调用节点等子任务里的人的时间算了进去；时间拆分的公式是近似；取消的反问没有结束时间；按原因拆分的时长不能与运行时长相加 | 增加子孙任务的事实；自动执行时长改用既有的有效运行时长；写明近似；取消的反问取中介节点执行的结束时间；时长按原因只给占比（design §5.1、§5.2、§7；proposal §5.2、§12、AC-4、AC-5） |
| F5 | Token 口径与既有任务用量不一致；缺“用量为下限”“未定价”标记；早于调用记录的单元会拉低均值 | 口径对齐为名下任务的全部调用；带出两个标记；Token 样本限定为已结束且不早于最早调用记录的单元（design §5.3） |
| F6 | 数字员工：轮次不能从计量回执反推；终态种类到状态的映射漏了普通完成；“审批准备”是工具类工作项，按清单结构判定一次通过会判错 | 直接读轮次表，查询代价在集中验证时实测；用既有的分类表；返工类工作项由类型声明（design §6.3） |
| F7 | 工作组：归属规则描述不准；动态工作流应按节点的 Agent 聚合；完成确认的每次决定在消息里已有，不需要从请求体取；人发的消息数要限定种类 | 按既有规则原样描述并共用一份实现；按节点的 Agent 聚合；删除从请求体取值的机制；只计聊天与派单（design §5.4、§6.2） |
| F8 | 平台合成的节点会被标成“已移除”；包装器换代后内部行仍是首次；恢复续跑会破坏一次通过；重跑原因为空没有规则；开了“触顶后继续”的循环看不出触顶 | 固定的系统阶段；换代改判为连带重跑；一次通过不看恢复续跑；空原因归首次；“触顶或跑满上限”（design §4.1、§5.1、§7） |
| F9 | 工作流名称没有冻结在任务上；历史上的反问回答存在旧列里；很早的任务没有运行时长记录 | 名称现查，已删除的显示占位名；经既有投影读取回答；没有运行时长记录的单元不进时间拆分（design §5.1、§5.2、§12） |
| F10 至 F12（次要） | 调用成功返回不等于操作生效；proposal 写了“次数”而表里没有；`sameMeta` 比较引用会误判；稳定性各项与自由协作预算没有写来源；性能一节留着“新增索引”的旧句子；节点执行归属应按任务取；汇总不应自动轮询；阶段类型缺三种节点类型并多出一个清单里没有的类型；测试清单缺若干用例 | 计数以账本为准；删去“次数”；逐字段比较；补来源；删旧句；按任务分块；不自动轮询；阶段类型补齐；补用例（design §4、§5.4、§6.2、§7、§11.1、§13、§14；proposal §3） |

修订时我对着源码复核了上表涉及的事实，另外发现一处检视没有指出的问题，一并改了：

- **人工重试留下的是占位行。** 人工重试时平台先给目标节点和受连带的下游各铸一条状态为失败、从未启动的占位行，真正的重跑随后以“恢复续跑”的原因铸出（`task-execution/infrastructure/taskRouteOperations.ts:2405-2461`、`task-execution/application/resolveSchedulerRunRow.ts:62-76`）。把占位行当执行会凭空多出一次失败，而且恢复续跑在账本上分不出起因。所以占位行不算执行，人工重试的次数直接数占位行；“一次通过”改用“有没有失败的执行、有没有人工重试”来判定（design §4.1、§7；proposal §5.2、§12、§13 第 10 条）。

设计门之后改动了四条产品口径（proposal §13 第 10 至 13 条）。用户 2026-11-26 批准整份 RFC 并要求完整实现（「完整实现整个RFC直到完结，允许提交上库到远端」），这四条与九条默认口径随之确认。

### 4.3 实现阶段的记录

（待核实项的复核结果、与设计的出入、集中验证结果、实现门结论、提交与 CI。）

## 5. 验收对照

| 验收标准 | 覆盖它的任务 |
| --- | --- |
| AC-1 | T4–T9、T14、T15、T20 |
| AC-2、AC-3 | T2、T6、T14 |
| AC-4 | T1、T2、T4 |
| AC-5 | T2、T4 |
| AC-6 | T10–T13 |
| AC-7 | T4、T7、T14、T15、T20 |
| AC-8 | T2 |
| AC-9 | T2、T16、T17、T20 |
| AC-10 | T2、T18、T19、T20 |
| AC-11 | T2、T14、T20 |
| AC-12 | T20、T21 |
| AC-13 | T14、T25 |
| AC-14 | T18、T19、T20、T22 |
| AC-15 | T25 |
