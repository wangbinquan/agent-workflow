# RFC-371 任务贡献与历史关联持久复用

状态：已批准的持久用量设计的具体化；设计候选，尚未实现或签性能达标。当前 CI 修复的七个冻结文件保持不变。本页不将原生页缓存已上线等同于三层缓存全部完成。

## 现有结果与本次改动边界

原验收范围的无缓存、首次导入、热命中报告已逐项比较全部 65 个传输页及全部集合：汇总、分类 Token、人民币、成员、缺口、顺序及 counts 相同。实际耗时分别为 13,960.633、16,310.603、10,983.252 ms；热命中复用 1,834 个原生 root、1,849 个页，481 个缺失 root 仍明确缺失。warm 目标未通过。

热构建的原计时为：Task 入口 10.93 ms，owner/event 收集 1,661.93 ms，原生收集 963.86 ms，Task 构建 1,163.14 ms，历史归属 2,114.87 ms，最终 cohort fold 76.41 ms，传输封闭 563.61 ms。工作空间共调用 get 64,812 次、put 60,391 次、page 62,023 次。原计时没有细分主进程的 stage/publish；约 6.60 秒的 Worker 计时不能代替约 10.98 秒的 HTTP 整体计时，也不能把全部差额归因于 SQL。

本次继续现有 `persistent-usage-facts-20261011.md` 的三层设计：原生事实页已实施；补齐 Task 数值贡献、历史关联索引和查询复用。保持原公开 Task/历史 owner 来源、原归属算法、完整原 EOF、source receipts、四桶 unknown、已受理费率、CNY、全部现有报告协议与页面。范围筛选仍决定查询成员，不决定采集完整人口；无任务数、调用数、页数、图深度或时间跨度预算。

## 当前源码中的可复用边界

1. `application/completeObservationCohort.ts` 先保留全部原 Task 和历史 owner，再逐 Task 调用 `buildCompleteObservationTask`；随后才执行 `selectCompleteObservationTask` 和报告维度/趋势。Task 数值准备可以保存为独立版本，范围/维度筛选继续执行原函数。
2. `completeObservationTask.ts` 的数值构建与 `buildCompleteObservationTiming`、span trace 同处一个函数。缓存须将它们显式分开：保存原数值贡献、原 attempt 事实和收集回执；每份新报告用新 `asOf` 重算开放区间、wall/running、attempt duration 和 trace。不能将旧 `durationMs`、`open`、Task timing 或 summary timing 直接复制到新报告。
3. `historicalObservationSource.ts` 的完整 owner/event、原生版本、root/reference、原 Task 关联与原生图可保存为封闭准备版本。`completeHistoricalObservationAllocation.ts` 当前按每个 native record 多次读取候选、root、accepted-record 的工作空间。准备版本增加原键索引，批量读取关联；仍由现有 `scopeMatch`、accepted 原值比较、冲突、共享 owner、unknown、timeBasis 和原维度逻辑裁决贡献。
4. `usageSelection.ts` / 完整 ancestry workspace 的累计包含规则不能按 delta Token 替代。新的累计值、父子边或 model 变化使相关完整 coverage family 重算。持久版本只保存原算法决定的贡献；不会把 Agent total 相加成 Task total。
5. `completeObservationReportService.ts` 的请求仍生成新的 reportId，`completeObservationSnapshot.ts` 仍生成新原快照 header，`completeObservationSourceRevision.ts` 仍封闭原来源。现有 `refreshKey`、snapshotId 和新连接的 data_version 都不能独立成为跨报告复用键。

## 应用源的事务版本

应用原表版本以每个明确来源关系的 revision 记录实现。SQLite 的 INSERT/UPDATE/DELETE 触发器与源变更同事务更新 revision；PostgreSQL 用真实 statement transition relation，只有实际变更成员才更新。事务回滚不推进版本。版本使用文本身份，不用有溢出边界的计数器；不把 count、MAX(id)、MAX(updatedAt) 或 TTL 当当前版本。

安装范围只覆盖统计实际依赖的明确关系，不给全应用所有表加触发器。原表仍由其原 owner 写入；统计层仅读平台提供的版本证明和原 owner 公共查询。platform 的逻辑 schema descriptor 同时生成两个 provider 的版本关系、函数/触发器和升级步骤；不得将 SQLite trigger SQL 直接回放为 PostgreSQL。沿用 `retainedOutputRevisionSchema.ts` 的 provider projection 方式，新增 descriptor 与原 retained-output descriptor 分别判别，原合同不变。

当前明确来源的完整 logical ID 与两种 provider 映射已在 [55 项来源清单](persistent-calculation-sources-20261012.json) 登记：29 个直接关系和 Task/System 两套共 26 个原生关系，31 份原源码身份保持。清单由静态 schema 声明和原 factory 后缀读取产生，没有执行产品模块；原 KEEP 关系的两种 provider 名称按现有 `schemaContract.ts:779` 映射。实现须逐项核对当前完整 canonical contract、全部实际读点和 I/U/D 行为，再启用缓存。任何未登记读点阻止快读，原完整构建继续可用：

| 来源                | 当前读链与关系符号                                                                                                                                                                    | 变化影响                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 原 Task 与尝试      | `completeTaskObservationFacts.ts` / `taskObservationFacts.ts` / `taskObservationKinds.ts`：tasks、taskRepos、nodeRuns、taskExecutionObservationSources；`query.ts`：taskCollaborators | 新增、软/硬删除、子任务/owner、名称、状态、原 workflow/workgroup snapshot、时间、原 kind 和 pending          |
| System 原任务与尝试 | `systemObservationFacts.ts`：systemAgentObservationGroups、systemAgentObservationOwners、systemAgentObservationSources                                                                | 内置 Agent 原组、原尝试、身份、名称、状态、owner/parent 与 backlog                                           |
| 原生 capture/归属   | `nativeUsageEvidenceStorage.ts` 的 Task/System 两套十三关系，加两套原 observation source；`observationNativeScopes.ts` 及其原资格读链                                                 | preparation、store binding、root 集合/结果、pass/page/head、父子链、step member、emission、revision 与原 ACK |
| 原历史 Task         | `historicalTaskObservationFacts.ts`：nodeRuns、tasks、nodeRunEvents                                                                                                                   | 完整原 owner、事件、root、原 usage 与原冻结名称/kind/runtime                                                 |
| 原历史 Memory       | `historicalMemoryObservationFacts.ts`：memoryDistillJobs、memoryDistillEvents                                                                                                         | 旧 job、全部尝试及迟到事件，不能由新 System group 隐藏                                                       |
| 原历史 Intent       | `historicalIntentObservationFacts.ts`：intentSessions、intentTurns、intentTurnEvents                                                                                                  | 原 owner、agent turn、runMeta、capture root 与完整事件                                                       |
| 原历史 MCP          | `historicalMcpObservationFacts.ts`：mcpRuntimeTestSessions、mcpRuntimeTestTurns、mcpRuntimeTestEvents                                                                                 | 原 runtime、turn 边界、原 root 与所有事件                                                                    |
| 已受理调用与用量    | `createCompleteObservationSources` 及 ledger/capture/platform adapters 的全部关系                                                                                                     | invocation、usage、capture、平台用量/停止证据/水位、费率可见性与 pending                                     |
| 冻结估值与展示名称  | `completeObservationValuation.ts` 的 invocation/price adapters；`completeObservationAgentNames.ts` 的 agents 及原 System owner                                                        | 原已受理目录、适用条件、缺少费率、原估值/费率版本、名称                                                      |
| 当前读取资格        | 原 admission/read 的 users、Task 公共 visibleIds 与平台 source 状态                                                                                                                   | 原 actor revision、当前成员、原项目/Task 准入及 cost visibility；每次请求仍执行原检查                        |

版本表、缓存版本/行/索引、原生派生缓存、报告的 pages/rows/counts/receipts 和本次缓存写入不推进应用源版本。`observationInvocations`、ledger、capture 和平台状态属于统计原输入，不能因为同属 observability 命名空间而一并排除。动态扩展的公开来源只有提供完整相同事务版本合同后才能快读；否则通过其原无上限 EOF 得到完整内容指纹。

初版可用明确来源关系的保守版本向量确认准备版本。当向量变化时，完整核对相应来源并按原 Task/coverage family 的完整内容指纹判断哪些数值贡献真正变化，复用未变贡献。不能把一个粗粒度版本变化误作所有 Task 的新增量；也不能因为目标 Task 没改而忽略其父子、共享 native root、原价格或可见性依赖变化。owner 范围可直接证明时登记原旧/新 owner；不能证明的变更扩大核对范围，不能丢弃该变更。

## 原生当前版本与重启

每份报告继续原 `HistoricalNativeVersionObserver` 的实际持续连接与前后 proof 检查。连接 epoch 和 revisionToken 是当前物理源确认的一部分；同 generation 下普通 WAL 写入仍使旧复用失效。源不可读、替换、同 ID 修订、删除、迟到 usage、session reparent 和未知父链均进入原完整路径，不补零。

派生贡献键使用原生事实版本的完整内容/成员/祖先指纹和 parser 版本，不能只用临时连接 nonce。服务重启先通过原生页缓存原完整核对路径重新确认当前内容，再按完整指纹复用未变贡献；重启的第一次确认与随后热读分别计时。新的持续连接不能凭相同文件 generation 跳过原核对。

Task/System 原已承认 native capture 仍由原 owner 公共资格端口确认，其关系变化包含在应用版本向量。外部 CS 用量使用原 authority、project、execution、meter、水位及 visibility 版本；没有闭合公共版本合同时保留原同步状态并走原输入确认，不直接读 CS 私表，也不把本地模型消耗和 CS 同一算力消耗计两遍。

## 持久状态与读取

新增的可重建状态分为 source revisions、封闭 preparation versions、准备 rows/原键关联索引、Task contribution versions/rows、当前版本 heads。Task 贡献指纹包括原 Task/input 事实、完整来源依赖向量、原生内容与祖先版本、归属/估值/parser 版本及原冻结价格身份；actor-qualified 源不能跨 actor/permission scope 复用。名称仍作展示属性，所有关联使用原 ID。

版本生成采用 staging，保存原来源回执、完整集合计数、完整顺序/内容摘要和原 EOF；只有全部来源/关系和贡献完成才原子发布 head。失败、取消、中断与接管保留 staging 状态，读者不读取半套结果。新快照只读取一个封闭版本；缓存损坏或版本不符回到原完整构建，不能把空缓存变成空统计。

构建期间原 snapshot 仍只读应用源，并可写自己的 TEMP 工作空间。持久派生写入在原 reader 释放后，沿原报告 Worker/主进程边界分段导入；版本 proof 在导入前后按原同快照/当前写入合同核对。原 source epoch 已变化时不推进当前 head。原生 proof 的现有有限重新读取规则保持，不增加无限重试。

Task 数值命中恢复的是原数值、原事实行、完整贡献集合及实际来源回执，不是新来源读取回执。旧回执保留原 snapshot 身份；新报告额外封闭本次当前版本确认与缓存完整身份，不能把旧 cursor/snapshotId 改名成“刚刚读取”。原范围 Task 入口仍重新选成员并获得本次真实 EOF，当前 actor/Task/平台费用检查保持。

准备行以原 namespace 的结构化相对身份恢复到新报告的 TEMP namespace，不做 JSON 全文替换。原 invocation/session/source/owner/record ID 不改。Task summary timing、attempt duration/open 和 trace 由本次原 `asOf` 及原 intervals重新计算；原数值 unknown/known partial、费率冻结、缺口及去重结果保持。

关联索引提供原有 localeCompare 顺序的完整流，批次仅约束 I/O/内存；一个 root/record 的关联多于单批时继续至 EOF。原精确事件优先、root 备用、重复候选去重、多个 owner 共享同一原 step、accepted 原值冲突、未知归属与全部版本均保持。不得把候选首项当 owner、把缓存的 candidateCount 当完整来源证明，或把未知桶当 0。

## 新范围与报告发布

新范围复用封闭 Task 数值、原 owner/event/native 事实与关联索引，执行原 Task-started cohort 或 usage-occurred cohort 的范围裁决、维度匹配、归属与汇总。完整历史记录的 scopeMatch/共同 Task/共同日期及 accepted 覆盖会随所选成员变化，不能直接复制上一个窗口的最终历史 fold。

归属结果按完整 coverage family/member 指纹复用；改变窗口/维度导致 family 成员或原归属条件变化时用原算法重算该 family。整日索引不代替任意时间边界的原 contribution 时间索引，Task 数量按原 ID 去重，执行时长继续区间并集和原百分位。

新报告保持独立不可变 reportId/header/cursors、全组 counts/receipt 与 nonce。先给 stage/publish 增加同一 opt-in 性能计时，分别记录原 lease/输入、stage 事务、完整验证和发布成本，再针对实际慢点做批量派生写入或同内容封闭查询结果复用。复用内容仍须新 header 与当前来源 proof；不能指向会随旧报告清理而消失的行，不能借旧总数跳过新输出人口封闭，不能把未测量的 stage 改动作为达标证据。

## 实施及功能验收

1. 冻结本设计与完整读点/logical ID 清单，独立功能设计检视；当前 CI 修复提交的主 CI 和默认完整 Windows 全绿后才写本批生产候选。
2. 以平台原 logical schema projection 增加明确 source revision 合同与双 provider 原迁移；逐个来源 I/U/D、事务回滚、空 statement、原 owner 变更与派生写入不污染版本的真实回归。原 SQLite 已应用迁移与 PG 升级历史不改。
3. 将原 Task 数值准备与当前时钟/trace分开；增加持久封闭准备、贡献、关联索引及原 Worker 导入。原完整构建作为无缓存 oracle，原业务断言和预算保持。
4. 对两种 provider 用同一原数据库的原入口核对：同范围、全新范围、不整日/跨日、usage/Task cohort、各维度、全部明细父组、同 ID 修订、I/U/D、迟到、shared root/祖先/累计覆盖、unknown/known-zero、未受理/failed、原费用隐藏与费率冻结。命中/不命中均逐条对拍所有 rows、counts、四桶、人民币、缺口和完整成员。
5. 单独验证新 asOf 的正在运行 Task/attempt、开放区间与 trace；验证 actor/Task/visibility 变化、物理源替换/不可读、服务重启、缓存损坏、staging 中断和接管。变化无法确认时走原完整路径，页面仍保留经原GET核对的完整旧报告，并显示其原统计时间。
6. 每个实际候选只生成一次必要原架构清单，有限 SOURCE/MATCHING 检视，精确提交并等待完整 exact-SHA GitHub 主 CI、默认完整 Windows 与新增具名行为执行。AW 不跑本机测试/类型/构建/E2E，不重启已停止的规模 CI。
7. 用原验收数据分别计时首次导入、稳定热命中、换范围、真实新增/修订与重启确认；报告源确认、准备/归属、scope 聚合、transfer、stage/publish、HTTP 到可见的 P50/P95 与实际人口。原 warm P95 <1 秒、Task detail <500 ms 待实测；原 10.98 秒不达标记录保留。

当前仅为设计候选。精确关系登记、源码、测试执行、性能达标、正式页面与整体 RFC 完成均未由本页代签。CS 自己的持久用量设计和部署验收继续独立进行。
