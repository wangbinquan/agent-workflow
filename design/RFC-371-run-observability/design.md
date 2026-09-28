# RFC-371 技术与交互设计

状态：In Progress，用户已批准完整实施。产品全景与验收见 [proposal.md](./proposal.md)；实际交付范围与未完成项逐批记录在 plan.md，原型不替代后台实现证明。

## 1. 架构落位与能力边界

遵循 RFC-294 的 feature-first 分层与 §15.3：提出新增 `modules/run-observability` 业务只读投影 context，拥有统计口径、使用量账本、运行区间投影、查询与定价版本。它不是 `system-operations` 的杂项功能；`platform/observability` 继续只拥有通用日志 / metrics / trace 机制，不拥有业务跨任务统计。

这是本 RFC 提出的架构演进，实施前需更新 required/offered 合同与架构清单；不把新 context 描述为既有架构事实。源数据生命周期仍由 TaskExecution、Runtime、Collaboration、SourceControl 各自唯一拥有。

```text
TaskExecution / Runtime / Collaboration 的 owner 事实
    → exact committed event / owner query projection
    → RunObservability ingestion application
    → 幂等 usage ledger + lifecycle intervals + query projections
    → actor-authorized queries → HTTP DTO → TanStack Query → 观测页

bootstrap：注册 owner adapter、数据库 adapter、增量投影 worker 与时钟
platform/observability：通用低基数运行指标、日志、可选 OTel 导出 adapter
```

- `domain/`：身份、互斥用量桶、贡献去重、区间并集、定价与统计口径；不引入 Drizzle/HTTP/runtime SDK。
- `application/`：摄取、对账、回填、查询授权、导出、告警评估；依赖自身 ports。
- `ports/`：usage store、checkpoint store、price registry、source query、task visibility、clock。
- `infrastructure/`：SQLite / PostgreSQL 同语义存储、投影查询与分页；跨域读取由 owner public query adapter 提供，不直接读 tasks/node_runs 私有表。
- `public/queries` 提供明确的总览、任务、Agent、调用与导出合同；不暴露任意 SQL、任意指标 DSL 或完整 AppDeps。
- TaskExecution 的执行写仍走现有 kernel/AtomicApply；本功能不接管调度、重试、限额、恢复或运行状态写入。

## 2. 执行身份

| 层           | 稳定键                                                                      | 语义                                                  |
| ------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| 业务上下文   | optional employeeCaseId / reactionId / workflowId / workgroupId + revision  | 筛选标签，不是另一笔消费                              |
| 任务         | taskId；rootTaskId + parentTaskId 可空                                      | 独立任务；根任务展开展示子任务                        |
| Agent 参与者 | agentId + frozenRevision + runtimeAgentId 可空                              | 不能只按可改名的名称归因                              |
| 逻辑活动     | nodeId + containerRunId + iteration + shardKey + wgRound + reviewGeneration | 重试所属的逻辑单位；保留各维度正交                    |
| 执行尝试     | nodeRunId + invocationId                                                    | 进程 / 恢复会话的一次调用，不复用 PID 当身份          |
| 调用片段     | spanId + parentSpanId + causal links                                        | 模型 / 工具 / 等待 / 调度；父子关系不自动等于因果依赖 |
| 用量记录     | sourceId + invocationId + providerRequestId 或稳定序号 + revision           | 实际账本的唯一贡献单元                                |

runtime 内部子 Agent 与平台调度的 NodeRun 是不同层。父用量已包含子用量时：账本记父 inclusive 范围，子明细是 attribution，只能分配父总额，不再新增贡献；如果提供互斥叶调用，则由叶贡献生成父汇总。包含关系未知时保留 `scope=unknown`，禁止将两者相加。

## 3. UsageEnvelopeV1 与账本

```ts
type UsageEnvelopeV1 = {
  schemaVersion: 1
  sourceId: string
  invocationId: string
  recordId: string
  revision: number
  taskId: string
  nodeRunId: string | null
  spanId: string | null
  occurredAt: number | null
  observedAt: number
  model: { provider: string; id: string; revision: string | null } | null
  reporting: 'delta' | 'cumulative' | 'final'
  scope: 'self' | 'includes-descendants' | 'unknown'
  coverage: 'partial' | 'complete' | 'unknown'
  source: 'provider-reported' | 'runtime-reported' | 'estimated' | 'legacy'
  inputUncached: number | null
  inputCacheRead: number | null
  inputCacheWrite: number | null
  output: number | null
  reasoningSubsetOfOutput: number | null
  reportedTotal: number | null
  reportedCost: { currency: string; amountDecimal: string } | null
}
```

所有数值非负；NULL 为未知，0 只表示明确报告的零。保留 raw 安全字段映射和 adapterVersion，以便重算；不保留秘密或整个原始消息。单位始终为 Token，货币采用 decimal/minor-unit 表达，禁用二进制浮点作为持久结算值。

### 去重与修订

1. `(sourceId, invocationId, recordId, revision)` 唯一。重复同值 no-op；同键不同值进入冲突诊断，不再次贡献。
2. delta 必须有稳定事件 ID；不能用时间戳 + 用量猜测唯一性。
3. cumulative 的计量范围由版本化 adapter 明确为 invocation 或 native-session；不能默认每次 invocation 都从零开始。native-session 以 runtime 注册身份、原生 session/lineage/generation、模型与包含范围保存快照；恢复调用先扣除受理时已知的同谱系基线再归属本次 invocation。例如首次100、恢复累计130，只增加30。fork 必须保存继承基线，clear/reset 新建代次；基线未知的余额标未归因/partial，不全归给新调用。同来源按有序 revision 替换，不以到达顺序覆盖。
4. 有依据的有效 final/correction 可校正 provisional（包括向下），修订留审计；`error_during_execution` 等失效终态的全零不能当纠正依据，不覆盖已知消耗并标 partial。真实零、有效修订、reset 与无效观测分别编码，不用盲目 `max` 掩盖差异。
5. 父 final 与 leaf deltas 的覆盖关系由 driver 合同确定；完成对账后原 provisional 被替代，不能同时入账。
6. 最后一次进程退出不一定收到 usage；关闭执行不等于 coverage complete。硬崩溃后展示已持久化的已知用量与缺口。
7. 旧 NodeRun 的非空总量可回填 attempt 级 legacy record；不合成 LLM request/spans。旧 0 缺少 presence 证据时标 unknown，不能自动写“零消耗”。

现有 OpenCode 平台 adapter 在 `services/runtime/opencode/events.ts:123` 做 delta 累积；Claude 平台 adapter 在 `services/runtime/claudeCode/events.ts:233` 只取 result 的累计 usage。实施先固定协议 fixture、查对应 upstream 版本，再扩展合同，不能将两种策略抽象成同一个 `+=`。

## 4. 指标字典

| 指标            | 定义与分母                                              | 缺失 / 注意                                                               |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| 总 Token        | 四个互斥桶之和                                          | 与 reportedTotal 不同则标不一致；不强补差值                               |
| 输入 Token      | inputUncached + cacheRead + cacheWrite                  | 默认图按三桶拆开；OTel inclusive input 在 adapter 转换                    |
| 输出 Token      | 已报告输出，包含已报告 reasoning 子集                   | reasoning 不再次相加；未知子集显示 —                                      |
| 缓存读取率      | cacheRead / 全输入                                      | 输入未知或 0 时 —；不是成本节省率                                         |
| 任务墙钟        | terminalAt - submittedAt；运行中用 asOf                 | 重开任务明确生命周期 revision；原 startedAt 不能假设为开始计算            |
| 任务运行态历时  | runningMs + 当前 runningSince 至 asOf                   | 沿用 TaskExecution 的运行状态合同，不重写已有预算计时                     |
| Agent 累计占用  | 所有选中叶 attempt 的执行区间求和                       | 包含模型与工具等待，不是 CPU 时间；可以超过墙钟                           |
| Agent 活动并集  | 所有 attempt 活动区间的时间并集                         | 可与任务运行态不同，不能混名                                              |
| 人工等待        | collaboration / TaskExecution 的 gate 区间并集          | 并行 Agent 可仍在运行；不能直接从墙钟减全部等待                           |
| 重试次数        | 技术 retry lineage 边数                                 | 工作组轮次、clarify、reviewIteration 单列                                 |
| 失败尝试消耗    | failed attempts 的实际 usage                            | 与重试消耗可能相交，不互相相加                                            |
| 重试消耗        | retryIndex > 0 的 attempt usage                         | 所有尝试减首次尝试；不把首次失败也当重试本身                              |
| 成功率          | done / (done + failed)                                  | canceled/interrupted 单列，运行中和等待中不在分母；可切全终态口径并改标签 |
| P95 完成历时    | 选中已 done/failed 任务的原始时长分布                   | 样本数一起显示，低样本提示；不平均分位数                                  |
| TTFT / 输出速度 | 首内容 token - requestStart；输出 / 生成区间            | 无真实时点不估成 0；推理 token 与输出速率口径注明                         |
| 用量覆盖率      | complete eligible invocations / 全 eligible invocations | 工具和纯脚本不进分母；“没有观测到的调用”另由源 checkpoint 差异反映        |

时间分布优先用独立图，需画互斥堆叠时采用公开优先级：人工阻塞且无活动 → 排队且无活动 → Agent 活动并集 → 平台工作 → 未分类；保留原始可重叠区间，不能把归一化图当源事实。

## 5. 时间、筛选和汇总合同

- 所有时间储存 UTC epoch milliseconds，展示按用户时区；query 必带 `from` inclusive / `to` exclusive / `timezone` / `asOf`。
- `cohort=started`：按任务开始时间选择任务，展示这些任务的生命周期消耗。任务列表、Agent 单任务贡献默认此口径。
- `cohort=usage`：按 usage occurredAt 选账目，展示窗口内消耗；跨日任务可在多个桶出现，但每笔账目只入一个桶。
- 只有 attempt 最终总量、没有 occurredAt 时，不能均分到时间轴。单列“发生时间未知”，可展示记账时间图，但必须标 `timeBasis=observed`。
- 查询结果携 `filtersEcho / asOf / projectionVersion / partial / freshness / coverage / unknownCount`；同屏卡片和图复用同一 query snapshot。
- 任务钻取只按 taskId 展示全生命周期；从全局窗口进入时提示“此处显示任务全程”。返回列表恢复原筛选。
- `taskScope=direct|subtree` 显式切换。全局默认去重叶 ledger；任务树包含值禁止再次与子任务加总。
- 多仓使用关系集合筛选；模型分布按调用实际模型归因，执行中切换模型时不能统归启动配置。

## 6. 费用与价格

`priceVersionId` 固定模型/provider、currency、effectiveFrom/to、输入/输出/缓存费率、长上下文或批处理条件。上报费用优先展示；推算费用分栏，不用一个字段覆盖两种性质。条件缺失时结果为“未定价/部分估算”。改价格不会偷偷改历史，用户显式重算生成新的 valuationVersion，可比较旧估算。

所有用户可见费用统一人民币 CNY，费率单位元/百万Token；原型使用人工填写的人民币示例价目，不声称真实厂商价格，也不是把外币符号替换成人民币。上游外币费用没有经过有依据且带版本的换算时，不能计入人民币总额。生产不自动读取付费账单或推断订阅套餐额度。仓库标签重叠时不给重复包含总额一个可相加的饼图。

### 6.1 管理入口与价格 owner

价格管理界面位于设置的运行时页，统计模块 RunObservability 仍是价格规则和估算的唯一owner。RuntimeManagement只提供exact public query的安全运行时摘要，不为改价调用旧runtime PUT/模型测试，更不直接读取runtime私有表或秘密配置。

管理合同：`GET /api/observability/pricing/runtimes`、`GET /api/observability/pricing/runtimes/:registrationId/versions`、`POST /api/observability/pricing/runtimes/:registrationId/versions`。路径使用不可变注册身份，避免同名删除重建误读旧价格。管理员鉴权后处理请求；普通任务查看权不附带改价权。版本请求带expectedRevision、configurationRevision、requestKey、currency固定CNY、provider/model身份、四桶decimal字符串、生效时间与来源说明；服务端校验非负/精度/有效区间、幂等和CAS，冲突保留草稿。

运行时名称可以删除重建，所以价格绑定要保留owner提供的注册身份/配置修订或新增明确generation，不能仅用名称把旧价移给新对象。每个invocation在受理时记录价格表快照引用；实际模型调用在该快照中匹配provider/model/计价条件。执行中换模型没有对应项时标未定价，不套默认模型价格。历史迟到usage沿用原快照；纠正价格另建valuationVersion。

输入、缓存读、缓存写、输出为互斥桶，reasoning属于输出子集。人民币金额使用decimal，最后才格式化到最多6位小数，极小非零值标小于显示阈值，不能误报免费。原始厂商实报与配置估算并列，不相加。订阅/包月价格不自动除以Token做“实际单价”。

CS托管adapter只消费平台授权返回的CNY金额、计量范围、完整性与priceVersion引用；使用execution/invocation映射去重。缺字段或无授权就是未定价，不倒查平台采购秘密；本地规则不得覆盖CS来源。完整实施须接通此合同；RFC-370 的并行宿主改造仍由其 owner 维护。

### 6.2 两种部署方式（用户明确要求）

独立部署与 CS 托管部署都是正式验收场景，不把托管列为未来占位功能。领域口径与观测页面共用，采集、身份映射、价格 owner 和持久化装配经端口区分。

| 合同     | 独立部署                                                   | CS 托管部署                                                                    |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 用量事实 | AW 本地 driver 的版本化 usage 记录；绑定调用与原生会话代次 | CS 已持久化的执行观测；绑定 project/task/execution/generation 与 AW invocation |
| 断线恢复 | 持久源游标重放，账本和 checkpoint 同事务                   | 按 CS committed cursor 续传；未持久事件不推进水位；不能断线后改走本地计费      |
| 价格管理 | AW 设置→运行时→Token成本，管理员独立保存 CNY 版本          | CS 系统管理→算力档位→Token成本；AW 显示平台管理、授权来源与可访问的管理入口    |
| 金额来源 | 受理时冻结的 AW 单价快照，匹配实际模型                     | 仅使用 CS 授权的执行级 CNY valuation 与版本；无授权或未定价显示原因            |
| 数据库   | 当前支持的 SQLite / PostgreSQL 均须验证                    | PostgreSQL，使用相同领域规则与数据库端口                                       |
| 可用性   | 不依赖 CS 服务、凭据、网络或安装                           | 平台接口不可用显示采集延迟/缺口；已持久化的历史仍可查询                        |

部署方式是装配能力，不以 URL、环境变量名称或当前有没有本地二进制猜测。每次 invocation 保存 `executionAuthority` 与 canonical source；同一执行不能同时计入本地解析与 CS 回传。平台同步的 Token 与 valuation 分开去重、分开版本化，usage 先到、估值后到不增加第二笔 Token。CS 平台采购费用和 AW 可见执行估算不是两个可相加的账目。

验收覆盖：独立运行时无 CS 可达；CS 模式断开重连与重放；重复/乱序用量与估值；实际模型改变；价格变更后的在途/历史调用；平台未定价或项目无金额授权；两模式相同用量样本的汇总与泳道口径相同。

## 7. 持久化、事件与恢复

建议表：`observation_invocations`、`observation_spans`、`observation_usage_records`、`observation_usage_revisions`、`observation_checkpoints`、`observation_model_prices`。小时/日 rollup 是可重建投影，不是真实账本。

执行启动通过 `run-observability/public/participants` 的必填调用受理参与者注入；三个独立部署启动根显式选择本地持久层，runner 不按环境推断部署。每次进程启动分配新 invocationId，在 beforeSpawn 中持久化接受时间、冻结身份与价目表修订；受理失败时该进程不启动。普通节点、多 Agent 宿主、fanout/aggregator、自动提交及合并处理共六个入口同样传递冻结身份。内部提交和合并归入 system 用途，保持任务关联。CS 托管启动根必须注入平台执行映射参与者，不能复用独立部署绑定。

TaskExecution 在现有事务提交链发出最小事实（started/status/attempt-finalized）；runtime usage 通过绑定 invocation 的 writer 注入。微批默认 250ms 或 100 条，使用有界队列；关键生命周期与最终用量走 durable 源记录 / outbox，提交失败显式标采集故障并重试。不得让 best-effort WS 承担账本可靠性。

投影 worker 在业务 commit 后消费持久事实，账本幂等写与 checkpoint 同事务；重启从最后已提交 cursor 续跑。先终态后补量、先子后父、事件重复和乱序均可收敛。未提交的 runtime 内存数据可能因硬崩溃丢失，页面保持 partial，不能承诺 exactly-once 源采集。

活跃任务 WS 仅发 invalidation / revision，高频数据限流；断连回退带 ETag 的有界轮询，后台 tab 降频。返回 asOf 而不是让浏览器无依据自增 Token。任务已结束但用量未齐显示“执行结束，用量待对账”。

## 8. 查询接口草案

| 接口                                        | 输出                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `GET /api/observability/overview`           | 当前授权范围的计数、用量、耗时分布、趋势与覆盖率        |
| `GET /api/observability/tasks`              | 游标分页；显式 sort / cohort，不全量扫描前端            |
| `GET /api/observability/tasks/:id`          | direct/subtree 汇总、参与者、时间口径、数据状态         |
| `GET /api/observability/tasks/:id/timeline` | 按 group / timeRange / parent / cursor 分页片段         |
| `GET /api/observability/agents`             | 稳定 agentId / revision 汇总与分页                      |
| `GET /api/observability/agents/:id/tasks`   | 任务贡献，可展开该 Agent 的 attempts                    |
| `GET /api/observability/usage`              | 受控 groupBy=model/agent/repository/source/time         |
| `GET /api/observability/health`             | 授权范围内缺失、延迟、对账冲突与采集能力                |
| `POST /api/observability/exports`           | 大范围异步导出，绑定过滤 / asOf / actor，下载时重新鉴权 |

`taskId/nodeRunId/agentId/spanId` 可在受控业务分析存储中索引；按 RFC-294 禁止进入 Prometheus 等通用 metrics labels 或 trace baggage。外部 trace attributes 采用 allowlist 和内容分级，不记录 raw prompt/path/secret。

## 9. 权限、保留与删除

沿用任务成员制，由 owner 提供 actor-filtered task visibility port；查询前应用权限，聚合后不能靠前端隐藏。任务树每个后代单独校验；无法展示的后代不能以包含用量旁路泄漏。结果标“当前可见范围”，但不暴露不可见对象数。Agent 定义可读不授予任务可读。

统计快取键包含 authority fingerprint/revision + filters + projectionVersion；撤销权限即失效。导出使用同一 query，不复用未经授权的 global rollup。未来管理员跨任务能力需独立 permission，不以导航入口存在作为授权。

默认只采集数值、状态、最小资源引用；Prompt/输出/工具参数按需单独授权。建议明细保留 30 天、小时投影 90 天、日投影 365 天，均可配置；最小账目身份与权限关联需保留到对应统计期限结束。删除任务或用户内容时按策略删除/去标识关联投影，权限撤销立即生效；若无法在保留后的 rollup 逐任务过滤，就不提供该私有 rollup，而不是越权复用。

## 10. 前端落位与视觉系统

正式入口改 `lib/nav.ts` / `router.tsx` / zh-CN/en-US，页面放 `routes/observability.tsx`；API contract 放独立 query adapter。复用 `Card / TabBar / Segmented / Select / Dialog / TableViewport / EmptyState / ErrorBanner`，所有控件颜色与间距使用现有 styles.css tokens。

新增公共原语候选：`ExecutionTimeline`（泳道+虚拟行+缩放）、`UsageBreakdown`（互斥桶）、`MetricValue`（已知/部分/估算）、`ObservationQuality`（采集状态）。不另造一套按钮 / 弹窗 / 状态 chip。

时间轴重要交互：名称区与时间区同步垂直滚动；单时间轴，缩放围绕当前区间；每段可键盘选中，Esc 退出详细面板；同级选择不丢滚动位置。运行中自动跟随可暂停；用户查看历史区间时不抢回末尾。>1K lanes 只渲染可见行；展开再拉取调用，模型事件正文不进入初始 payload。

目标性能（待实测的设计预算）：100K 任务、10M usage records 时，常用 7 天筛选 warm P95 <1s；任务概要 <500ms；首批 200 timeline items <1s；初始 payload <300KB gzip。SQLite 与 PG 分别验证，不以本地小 fixture 证明达标。大跨度允许降采样并显示精度；成本账本不可采样。

## 11. 测试策略与验收证据

- 领域对拍：互斥桶、inclusive/cache/reasoning 映射、父子去重、重复/乱序/终态修订、NULL vs zero、负值拒绝、币种与价格版本。
- 执行族：单 Agent、DAG 并行、嵌套 loop、fanout、工作组回合、runtime 子 Agent、子任务、clarify/review、retry/resume/cancel/interrupted。
- 时间：跨天/夏令时、未知 occurredAt、人工等待与运行重叠、墙钟/运行态/活动并集/累计占用、分位数低样本。
- 权限：owner/collaborator/admin/revoked，统计/排行/搜索/下载同结果域，无越权计数旁路。
- 崩溃恢复：source commit 后 / ledger commit 前后 / checkpoint 前后 fault injection，对账后与源逐条相等。
- 浏览器：390/768/1440px、明暗、长名称、键盘、返回筛选、千行泳道虚拟化、部分数据、断连、空/错误状态。
- hosted CI 为实施质量权威；本次原型仅做浏览器交互、视觉和 fixture 对账，不启动生产服务或运行全仓门禁。

## 12. 本次实现前的待决点

默认建议已体现在设计，可在评审后调整：新增独立 run-observability context；默认保留期限 30/90/365；费用先做估算与来源说明；告警仅提醒；runtime 细粒度按能力渐进接入。上游协议的精确字段、现有持久事件是否足以无缝回放、恢复阶段的 invocation 边界在 P0-T1 固定 fixture 后决策，不留隐性假设。

### 实施补充：原生计量 driver 能力

协议载荷解析归属现有 RuntimeDriver：OpenCode 与 Claude 各自提供可选 normalizeUsage，运行时注册表分发，中立边界只校验统一 measurement。调用方不按协议字面量二选一；未注册或未声明计量能力的 driver 返回 unsupported 覆盖，不调用其他协议的解析器。统计领域仍只处理规范化记录与覆盖关系。

### 实施补充：根 stdout 持久源

根进程在本地 authority 受理后，经已选 driver 的 normalizeUsage 生成数值证据；序号、采集时刻、invocation 和原生根会话绑定在写入前固定。TaskExecution 在既有 owner fence 与 nodeRun 行锁之后，将原始事件和 task_execution_observation_sources 同事务提交。投影源只含数值及诊断，不依赖进程存活或当前运行时目录。

每个 nodeRun 是独立有序源，源序号来自事务内生成的 ID。消费者在账本及 cursor 提交后才确认源行，确认中断后可重放；不同节点按稳定身份轮转，每次最多 100 行，失败节点仍推进轮转位置，不推进计量水位。后台恢复循环纳入 provider 的 pause/resume/stop/drain。chunk 只提交持久源，后台消费者独立投影，不在 stdout pump 中等待统计数据库往返；投影故障不改进程结果。

CS authority 不生成本地数字源，消费者也再次排除托管调用，避免和平台回传重复累计。未知 provider/model 保持 null，恢复调用缺少累计基线时保留 unknown，不用配置默认模型或零基线补齐。此批只覆盖根 stdout；原生文件模型补证、子会话采集和 CS usage/valuation 同步继续实施。

## 15. 原生 OpenCode 模型补全

独立部署的 driver 根据最终 spawn env 读取原生 SQLite，仅以已观察 step 的 id/sessionID/messageID 关联 assistant 的 providerID/modelID；配置默认模型不能替代实际模型。支持 OPENCODE_DB 的绝对/相对路径；内存库和无法定位的通道保持未定价。只读查询逐次关闭，不扫描历史数字或把旧 session 总量重新归属本次执行。

数字先入独立持久来源；模型稍后到达时沿用同一 recordId、增加 revision。允许 null→实际模型和同模型的 provider:null→已知 provider，已有非空模型或 provider 相互矛盾仍报告冲突。后续读缺失保留已证实归因。每次 invocation 最多保留 200 条补算候选，进程排水后用 50ms 预算重试，未解析/超限均保留明确缺口。补算只追加数字来源，不复制 stdout、Token 累计或生命周期事件。

CS 托管 invocation 不使用本地 reader 或价格；本批仍不代替 CS 授权源同步。实际子 Agent、Claude 路由、崩溃后的长期模型补采与两种部署实机验收仍需后续证据。


模型证据使用独立 `modelRevision` 指向原生来源修订。数字下降被拒绝时，只能补全同一身份的未知模型/路由，原数字 revision、贡献、水位与 partial 诊断保持不变；冲突模型和 invalid-final 不补全。这样迟到补模型与预算耗尽不会将较旧数字伪装为新的完整报告。数字修订临时缺失模型时沿用已证明模型及其 modelRevision。模型补证写入失败只记录诊断，保留原持久数值与任务结果，不把已成功运行改成失败。


## 16. CS 授权观测源与同步边界

托管 source adapter 调用 CS `/v3/business-tasks/:taskId/observations`，baseUrl 与现有服务身份头由托管装配根显式提供，领域不读宿主环境猜测部署方式。每次请求刷新身份头、限制 1–500 项、携带取消信号与 15 秒网络截止。快照 ID、页游标、committed watermark 均作为不透明值传递。

返回值严格对应 RFC034 executionObservationsV1：用量采用 CS 已归一的 projection.contribution 和 projectionRevision，不能再次减 basis.baseline；数字原生 revision、模型证据 modelRevision、用量投影 revision、valuationRevision 各自保留。人民币估值独立到达并引用 usageRevision，无金额授权、pending 和 unpriced 都是 null，不用 0 或本地价格代替。空页也处理 visibilityRevision。快照续页必须仍属同一快照和冻结水位。

断连、HTTP 状态、协议错误、快照失效各自返回明确结果；404 只能说明来源未找到，不能据此宣布整个 CS 不支持观测。平台不可达不会改写 executionAuthority。后续同步事务须将整页投影、回执和 committed cursor 同时提交；快照先进入暂存代次，全部页到齐后再原子替换，不能在首屏导入时清空历史。可见性变更先撤去旧金额展示，再完整重取授权快照。此接口实现不等于后续持久同步及托管启动根已接通。


## 17. 平台观测的持久同步

平台安装来源、项目和业务任务构成同步绑定；独立本地用量账本与平台 canonical 投影分别持久化。`observation_platform_sources` 记录当前代次、游标、金额可见性和同步状态；`observation_platform_records` 保存用量与估值，并以执行身份/source/record/kind 分开去重。用量采用 projectionRevision，金额采用 valuationRevision，不再次扣累计基线。金额引用的 usageRevision 尚未到达或已过期时，读面先返回 pending/null，真实零额继续保留零。

同步每轮在事务外获取一页，再在同一事务内检查本轮状态修订、更新投影和 committed cursor。同修订不同值整页回滚；迟到网络响应不能覆盖已提交的新页。首次或恢复快照先写暂存代次，所有页在同一 snapshot/through/asOf/expiry 内到齐后原子切换当前代次；发生故障时保留此前完整视图。来源404与能力不可用分开；已有暂存快照404会丢弃暂存并重新获取首屏，首次任务404只记录来源缺失。

金额可见性变更（包括空增量页）先停止返回旧金额，再重新请求完整快照；重新开放时也须完成新快照才展示金额。平台不可达保留上次数据、游标和明确失败状态，访问不可用则隐藏旧金额并要求重取快照，均不调用 AW 价目表。查询通过数据库的一致快照读取状态、数据和估值依赖，跨页游标绑定当前代次及状态修订，视图变动需要重启分页。

本批提供持久 source 应用与 SQLite/PostgreSQL 实现；AW invocation 映射查询、RFC370 托管启动根、同步后台生命周期及正式页面仍须继续接入。


## 18. 调用归因查询与平台安装身份

新受理的托管 invocation 必须冻结 `authority.sourceId`，它是平台安装身份，不是可变 URL。唯一执行键由安装来源、项目、执行资源与代次组成；任务和子任务仍属于不可变受理内容。历史缺少安装身份的已接受文档读取为 `sourceId=null`，查询返回 `legacy-unbound`，不根据当前平台配置补写归属。独立调用的原受理合同和人民币价目表快照不变。

调用查询只按已接受的 authority 选择数据源。本地页精确匹配 invocation/task/node/agent；托管页读取冻结 source/project/task 绑定，再按 subtask/execution/generation 过滤。返回原始 canonical 用量投影、独立估值与平台同步状态，不再扣 native baseline，也不把金额记录当第二笔 Token。CS 的 modelRef 保持不透明引用，不猜 provider 或模型名称；迟到、隐藏、未知与真实零金额沿用平台读面语义。

每轮最多读取 500 条源记录，过滤后可以返回空 items 与有效 nextCursor；调用方必须继续分页，不能把空页视为零用量。游标绑定 invocation 和不可变 authority，平台游标同时绑定代次和修订。本地页明确声明 live-page，不声称多页汇总具有同一快照；正式统计必须另接一致快照汇总。该端口是内部读接口，后续 HTTP 入口须先调用 TaskExecution 的任务可见性查询。当前没有托管 bootstrap、统计 HTTP 或页面接线完成的声明。


## 19. 正式任务观测查询与页面

运行与仓库增加 `/observability`。任务列表以任务创建时间 `[from,to)` 选择 cohort，每行显示该任务自身全生命周期消耗；子任务单列。列表、任务明细的 `asOf` 是本轮读取快照时间。翻页和从任务返回保留原窗口，自动轮询只更新窗口内的任务；显式刷新重新锚定近 7 天/近 30 天/全部时间并回第一页，页面显示实际时间范围。

TaskExecution 提供任务可见性、生命周期与 nodeRun 尝试事实；RunObservability 只依赖该公开查询合同。启动根将任务事实工厂与用量/平台投影读面绑定到同一个数据库 snapshotRead，任务、接受身份、四桶贡献和不可变价格快照在一次读事务中汇总。每页最多 25 个任务，每任务最多 1000 次调用、1000 个尝试与 10000 条各来源记录；超限明确返回部分数据，不把有界结果声明为完整总量。

独立 AW 按调用受理时冻结的价目表和实际模型估值。托管调用按 source/project/task/subtask/execution/generation 精确关联 CS canonical 贡献与估值，不再扣基线，也不使用 AW 价格。平台 modelRef 仅作不透明相等比较；父子覆盖归一后只有整个 canonical 记录均被采用，才沿用其整笔平台金额，部分桶不能按比例猜拆。首次同步、失败、金额迟到、未定价和项目未开放费用都有独立状态。

任务整体、Agent/修订/用途贡献与节点尝试统计由同一份读取结果派生。用量未知与实报零分开；已知人民币金额使用精确十进制求和，页面最多六位小数，极小非零额显示“小于 ¥0.000001”。任务墙钟、运行态累计、尝试累计和活动并集分别命名；没有任何已知尝试边界时显示“—”，缺边界尝试及无关联尝试的调用另计。

共享 ExecutionSwimlane 按共同时间轴绘制 nodeRun 尝试，恢复调用共用一个尝试区间。点击或键盘打开公共 Dialog 展示该尝试贡献与技术重试/工作组轮次/评审轮次；关闭后焦点返回原泳道。中断等无结束时间的区间不延伸到当前时刻。

本批提供正式读取路径与页面，不把它当作 RFC 完整收口：跨任务 Agent 汇总、子树汇总、usage cohort、导出/异常与采集健康页、RFC370 托管启动根及两种部署实机验收仍按总计划推进。
