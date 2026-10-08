# 历史原始执行用量恢复

状态：设计门 v3 VALID/PASS 已消费，历史恢复实现候选正在独立功能审查。新执行入口已采集，不代表历史全人口已经进入统计；本文件补齐原始历史来源，不改任务业务生命周期。

## 已证实的问题

本机原库的完整只读审计表明：243 个历史记忆作业没有新版 System group，其中 151 个作业实际有 152 个唯一原生 step，已知输入 1,338,864、缓存读 494,216、缓存写 0、输出 327,324，合计 2,160,404 Token。35 个原生会话凭据有缺口；这些作业必须保留，不能当作没有执行或零用量。最初将 group.kind 写成 memory 的 v55 审计无效，正确匹配为 memory-distill。

进一步原库审计中，3,057 条 node_run 有 1,059 条保存原生会话根，其中 949 条未关联 observation_invocations.document.nodeRunId。这只是原受理关系缺失，不能直接断言 949 次模型调用或其 Token 数。意图有 38 条 Agent turn、37 条原 capture_root_session_id；System group 只有 2 个 intent-turn。须按原 turn/attempt 逐一核对，不能只补记忆提取便宣布全来源完成。

现行完整报告依赖 AcceptedObservationInvocation、受理后的数字账本及 before-spawn/native completion 证明。历史 owner 常只有真实作业/执行、原会话与原生数字，没有原受理或历史费率。给它们调用现行 accept、补 Task、用当前价格或伪造开始前 nonce，会把事实变成编造的账单。历史必须由独立的已观测原事实进入同一个报告。

## 原始 owner 范围

| 来源                                               | 原始业务 owner                                             | 原始执行与会话关联                                                    | 新采集重叠判据                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 任务、工作流、工作组、数字员工、融合、Git 内置节点 | Task Execution 的 task/node_run/node_run_events            | 原 run ID、opencode_session_id、冻结 runtime/原事件                   | 原 observation_invocations.document.nodeRunId、原已计入 record ID                                   |
| 记忆提取（全部五种触发）                           | Memory 的 memory_distill_jobs/events                       | job ID、全部 attempt_index/root/parent 事件及最终会话字段             | System owner 的 memory-distill + original_id + original_attempt，不按整个 job 有 group 就跳过旧尝试 |
| 意图生成                                           | Intent 的 intent_sessions/turns/turn_events                | 原 Agent turn ID、capture_root_session_id、run_meta_json 与原会话事件 | intent-turn + original_id=session.id + original_attempt=turn.id                                     |
| MCP 会话                                           | Resource Catalog 的 mcp_runtime_test_sessions/turns/events | 原 session/turn、冻结运行时、会话与原事件                             | mcp-runtime-test 的真实原 session/turn 对应关系                                                     |
| 运行时探针                                         | Task Execution 的正式 probe 原事实/可保留原会话证据        | 有正式原记录时消费；没有历史 owner 时只说明不可恢复，不制造一次执行   | runtime-probe 的原来源标识                                                                          |

所有原 owner 列表、全部尝试、全部 root 转换、全部子会话与数字记录均到真实 EOF；页大小、缓存大小和短事务批大小只限制工作内存，不限制人口。原来的普通目录、权限入口和已受理执行合同保持。

## 合同与组合根

1. 新增报告专用、显式区分的 `historical-observed` 原执行事实。它保留原 source kind/owner ID/attempt ID、真实 parent task、原状态和原时间；报告引用键可由这些事实稳定派生，但字段必须叫 referenceId，不能声称是历史 invocationId。原调用受理 ID、acceptedAt、费率版本缺失时明确为 null，不能以观测时间或 job.createdAt 代替。
2. `AcceptedObservationInvocationSchema`、live 账本受理、原 before-spawn/完成证明和报价写门保持原义。完整报告的执行与 allocation 使用区分联合：原 accepted 分支逐字保持；历史分支从原 owner 与原生只读记录构建，不能送入受理或数字账本写入口。内部排序/连接使用报告 reference key；传输及页面仍清楚区分真实受理 ID 与历史引用。
3. 各模块只读自己的业务 owner，以窄公共查询提供分页事实。平台原报告 Worker 在同一个原应用快照上组合 Task、Memory、Intent、Resource Catalog 查询，观测端口消费结构合同；RO 不直接读取别的模块私有表，不增加 offered DAG 例外。公共合同必须由真实 Worker 工厂返回值消费，不能仅加类型声明。
4. Runtime Management 提供报告专用原生只读快照：按原会话凭据读取实际原生存储，递归会话/步骤全部到 EOF，消费原四桶归一算法与原真实模型字段。原配置名/版本无法恢复时显示未观测；不能根据当前默认配置、ID 字形或当前模型目录补历史归属。
5. 原应用 owner 与原生文件快照分别有真实身份、generation、水位、全部人口与内容指纹。保留开始/结束指纹并按原事实封存派生报告；历史没有 before-spawn 时只证明本次原始读取到 EOF，不声称完整历史修订或零调用。旧不可变报告继续可读，新缓存家族独立刷新。

## 全量、去重与归属

- 先完整保留原 owner/attempt/root 引用，再完整保留它们覆盖的实际数字，最后计算分配；不能先取某一页 UI 行作为统计输入。
- 原生身份以实际 native source + part/step ID 为准。当前已受理记录与历史来源覆盖同一 ID 时，全局只计一次；比较全部四桶和模型，不以“最新一条”覆盖冲突。重复交付、多 root、父/子根、同会话重试都必须验证。
- 原始 attempt/root 不能唯一证明数字归属时，保留唯一已知数字与全部候选引用，列为归属缺口。数字自身已知与数字属于所选范围是两个独立判据：只有完整候选集合都属于本次真实时间/Task/Agent/算力/用途范围，或原数字自身的真实字段足以唯一证明所选维度时，scopeMatch=matched，才能向相应范围合计贡献一次。全部候选均已确定在范围外时，scopeMatch=excluded，不贡献所选合计、不制造所选范围缺口，完整原来源回执仍保留原记录。范围内外候选混合，或任一候选归属未知时，scopeMatch=unresolved，保留原数字和全部引用于未确定归属行，不能加入该范围的已知 Token/费用合计。未确定归属的已知原始数字与所选范围合计在页面明确区分，不能把范围外可能存在的消耗算进某一天或某 Agent。不能将同一数字复制到多任务再汇总，也不能为了避免重复而删除原 owner。
- Memory 按原 attempt/root 与当前 owner 对照，避免一个已采集的新尝试掩盖同一 job 的旧尝试。缺少 run 或 root 的原作业也进入完整人口并标缺口。
- parentTaskId 只来自真实 owner。父任务含真实子任务与系统工作，Task 明细、Agent/模型/算力/来源/用途维度和总览采用同一分配人口与去重事实。
- 原 Task 开始时间与历史作业 createdAt/startedAt 分开；未知开始不制造运行时长。Task 详情和范围成员树包含该原 Task 的所有真实子执行/系统作业，不再以子执行自己的时间排除它。独立来源有开始时按真实开始入选；仅有原创建时间时按真实创建入选并标明时间依据。
- 原 node_run 没有 createdAt，不能凭空补该字段。它没有 startedAt 时，若原 parent Task 存在，则沿既有 Task cohort 使用该原 Task.startedAt 判断所属任务的时间范围，单次 executionStartedAt 仍为 null，泳道不画虚构执行区间，时长仍未知。原 parent Task 也缺失或没有可证明的时间时，引用进入 unknown-time 原人口：每次范围查询都保留可见未定时间引用及原数字，显示“时间未观测”，scopeMatch=unresolved，不加入任何日期/范围合计或趋势桶。不能将 0、观测时间、文件mtime、首条step时间或当前时间当作原开始/创建。未定时间人口和原数字另列在同一完整来源回执与明细分页中；即使不是范围合计成员也不丢弃，不把它改成普通新Task。
- 归属资格按完整候选集合判定，不能先按范围过滤候选再宣布唯一。每个字段都使用原可证明事实；未知 runtime/Agent 不能匹配指定 ID，仅相应 unknown 维度可明确选择未知事实，不能借选择 unknown 给未知时间获得日期资格。全部未确定范围行携带原 source/owner/record ID、候选集合、缺口、原四桶及未计入所选合计标记。

## 用量、费用与页面

输入、缓存读取、缓存写入、输出分别保留数字和未知状态。已有数字即使历史受理/基线不全也显示为已知消耗，旁边用简短缺口状态，不将总览、趋势或明细清空。不能用 0 代替未知桶或缺会话。原生 reasoning 的归一遵循现行原解析器，不另行重复计数。

仅原始受理/报价证明能支持人民币估值。没有历史运行时/费率版本的记录显示“历史费率未观测”，费用为未知；有原报价的记录按原冻结价格显示已知 CNY，汇总保留已知金额并标不完整。不得将当前验收价格反套历史，也不显示美元。

历史执行在正式 Task 追踪、Agent/模型/算力明细和总览可追溯到原作业/执行与原生记录；原执行、真实状态、原引用、分类 Token 和简短缺口均显示。总览卡片、质量说明仍只在总览页；不恢复更多筛选、CSV 导出或无信息的关注任务卡片。

## 实施及验收

- 先落报告区分合同、全量 owner 查询与完整源组合，再接原生历史读取、全局去重与 Task/维度/趋势/泳道/已知费用。不能只为本机 151 个 job 手工写一次 Token 总数。
- 真实 SQLite/PostgreSQL 回归覆盖超过单页的 owner/attempt/root；分页全部 EOF，无人口限额；同 job 新旧尝试混合、父子多根重叠、重复/冲突 part、未知/已知混合桶、无原价、缺 root、深层子会话、刷新、旧报告读取、全部筛选及 Task 明细一致。歧义候选跨两个时间窗/两个Task/两个Agent-runtime-purpose，须保留完整候选而只给有原事实资格的范围贡献；全候选都在范围内的唯一原数字只贡献一次，全部候选确定在外时排除且不制造所选缺口，内外混合或未知才列未确定归属。未知开始NodeRun分别验证有原Task时间、无原Task时间与未知时间分页人口，不能将其默认为零时长或消失；Task明细和范围合计的纳入/未确定人口分别与完整原回执核对。
- 保留全部原 accepted 执行、原 invocation/capture/价目/祖先/owner 断言、预算、测试用例；不得用模拟 SQL 行或放宽完成条件替代真库。
- 本机只 scoped lint/格式与一次原始元数据生成；AW 测试/类型/构建/E2E 以 hosted exact-SHA CI 验证。独立按路径功能设计门及实现门，不做安全检视。
- 本机真实验收逐页核对全来源人口与每个唯一原生 ID/四桶，至少恢复已证实的 2,160,404 历史记忆 Token；949 条缺受理 node_run 与全部历史 Intent/MCP 分别核实，不能将待核范围当作已经通过。
- Git/数字员工、定时/事件触发验收以及 CS 本机部署继续按已有授权范围推进；统计修复不代替这些真实入口的验收。

记忆作业的最终会话字段仅用于核对原事件：全部事件已到 EOF、并且最终会话确实出现在某次原尝试中时，作业行作为 owner 元数据保留，不再制造一个重复执行引用。各次 `attempt_index` 保留；原尝试缺少起止时间时仍为 null。全部引用均缺事件或最终会话不在事件中时，原最终会话作为未知尝试的独立原事实保留，不猜重试序号。原生数字、原 NodeRun 保存的汇总值和所选合计分别显示。

候选增加双 provider 的四 owner 超过 200 条及事件 EOF、两次记忆尝试、部分四桶、冻结 CNY、父子共享 part/跨时间范围、211 原生 part/211 深度子会话、当前受理重复 part、实际原生版本变化回归；前端覆盖全部分类、明细分页、完整候选范围、刷新后关闭旧报告弹窗、真实泳道与未知区间。Windows 原有命令和预算保持，仅登记新增原始历史回归。AW 没有在本机运行测试、类型、构建或 E2E；hosted CI、全来源真实数字核对和正式页验收仍待完成。

原始证据：`/private/tmp/observability-aw-all-task-type-validation-20261008-v1/legacy-memory-original-native-audit-v57.json`、`historical-owner-population-original-snapshot-v62.json`、`historical-owner-link-original-audit-v63.json`。设计回执为 `/private/tmp/observability-aw-historical-original-execution-design-review-20261008-v3.json`。未向历史受理或数字账本写入伪造记录，未宣称恢复已交付。

首轮实现回执 v1 为 INVALID：共享 Windows workflow 在检视过程中加入并行 Task lease 的三处登记；该输出完整保留，不能将这轮当作 PASS。已确定的两项归属问题一起修正：历史 NodeRun 优先采用原 override ID/name，仅有 override 名称时 ID 保持未知，不误绑模板 Agent；已由原 Task cohort 选中的全部子执行不再按子执行状态二次排除。双 provider 回归追加模板/实际借用 Agent、仅有历史名称、done Task 下 failed NodeRun/Memory 的范围及 Task 详情对拍。UI 测试沿实际 ByRoleOptions 合同去掉不存在的 exact 选项，字符串 name 仍为精确名称匹配。

真实全时间报告 v67 的全部分页已到 EOF，3,057 条原 NodeRun 全部在历史执行中保留。6,843 条唯一历史原生记录的实际 ID、会话、时间、模型与四桶逐条比对，无差异；6,625 条新增历史数字与 223 条受理记录合并后为输入 31,703,031、缓存读 167,542,827、缓存写 0、输出 9,147,542，合计 208,393,400。218 条与原受理重复的历史原生记录未再次计数；152 条旧记忆 step 全部恢复。已知原受理 CNY 仍为 ¥4.165538，历史原价未知的部分未套用验收费率。原始核对留在 `historical-complete-v67-original-native-reconciliation.json`；这只证明原始数字与全量读取，不代签范围归属修正、实现门或 hosted CI。
