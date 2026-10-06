# A-T5：System Agent 完整执行族、保留内容与真实调用入口

本片承接已批准的 system-agent-common-core.md、agent-invocation-factory.md 和 agent-material-workspace.md。它继续 Stage A；没有 CS adapter，不关闭 A-T5、A-T7、AC00 或 A-G。先接通 Intent、Memory Distill 和 Change Narrative，RC-MCP 的完整诊断执行族、runtime smoke 与通用脚本在随后增量中接通。

## 需求与责任

当前 services/systemAgentRun.ts 已将原完整执行算法委托给 TE application/systemAgentRun.ts。normal composition/systemAgentRun.ts 能使用选中 preparation，但三个真实普通调用方仍默认选择 native facade；Intent 和 Memory 还以物理 scratchDir 释放保留内容。只存在 normal runner 不能使这些入口适配非本机实现。

TE 的 application/ports 与 exact public/participants 增加完整 System 执行需求合同；它接收 AW 的 persona、prompt、运行策略、已解析 runtime binding 与逻辑 workspace scope，返回同一 PreparedSystemAgentRunResult。实际执行只调用已有 runPreparedSystemAgent 和唯一 runSystemAgentCore，不复制业务算法。normal 调用方必须接收已选中的完整 family，没有缺成员时重选 native 的兜底。

RM 拥有 runtime material 引用和 System workspace 的准备、seed、保留、释放。保留内容释放端口只接收 owner 的 retainedRef 与原调用方的逻辑 scope，返回原 removed/reason 结果；native implementation 私有解释原 parent/name/root 并调用原 releaseSystemAgentScratch。执行者只按原业务分支决定什么时候释放。同一 selected family 的执行和释放不可分别选择实现。既有原 release 函数、native facade API 和结果字段均保持，不在此次重构改变原判断或规则。

RM native composition 为同一次执行选中材料 compiler、protocol、evidence、workspace、execution/receipt 和 cleanup。一次 compile 的同一 material 在原 late bind 点执行；编译、绑定、取证和释放均保留真实 receiver。正常请求和结果不包含 binaryPath、scratchParent、scratchDir、native plan、cmd/env 或本机 handle。public 上只开放有真实消费方的合同；本机 fixture command 等扩展留在 native binding 中。

## Runtime 与工作内容的传递

原 runtime 解析算法继续在各自现有 owner 中执行，保留查询、配置等待、fallback 和错误时点。原 binary 列只在其 native infrastructure/composition 边界转为 RM-issued runtimeBinding；已解析的 protocol、model、sandbox 与 configDir 仍是 AW 材料声明。实际根将同一 RM 绑定器传入该解析出口及 System family；编译只解释本族发出的引用。不能在业务 application 中用路径换取一个看似逻辑的字符串，也不能重新查询 runtime 来代替原已解析快照。

逻辑 workspace scope 保留原业务用途与名称。Intent 用 turnId；Memory 在原位置生成一次 distiller 名称，整个补问链复用；Narrative 在原执行开始处由选中生命周期产生原随机名称。native adapter 私有保留 Intent 的 appHome/intent-scratch 和其他调用方的 appHome/scratch 布局。名称生成、parent 读取、seed 读取和目录创建均在原时点，不把 prepare 提前到 bootstrap。RM 是生命周期 owner，不新增一个与已批准方案冲突的 SC 生命周期 owner。

## 三个调用方

Intent 的 turnEngine 与 dispatcher 接收所选 System family，runtimeResolver 提供正常 runtime binding；实际 CLI SQLite、CLI PG、HTTP 与 queued resumption 根完整传递。原 semaphore、INTENT.md 和 dump.seedFiles 顺序、sink、timeout、stdout cap、retainScratchOnSuccess、capture 完成及 settle 业务分支保持。成功解析的原 releaseScratch 分支向同族 retention 端口提交 result.retainedRef 与 turn scope；保留标记、失败 reason、日志和 runMeta 重建顺序保持。

Memory 的 composeMemoryOperations、tick/start、runtimeResolver 与 runDistill 传递同族。runtime 仍一次 per tick 解析；prompt 保存、scope/context、随机名称与 sink 仍在原点。整条协议补问链保持总 deadline、同一逻辑 workspace scope、resumeSessionId、每轮剩余 timeout 和原 retry budget。链尾释放继续保留原 status 分支和原失败结果，不更改协议解析、候选持久化、调度或退避。

Narrative 的 server/tasks 根传入完整 family 和正常 runtime resolver。runGeneration 保留 runtime 读取、prompt 构造、timeout、日志、错误分类、JSON 解析和持久化顺序；workspace/native parent 由本机选中边界解释。任务访问、code workspace、inflight/generating/failures 等已有业务内容保持。

## 兼容与验收

services/systemAgentRun.ts 的全部 native options/result/seed/status、buildCtx、wrap-only、testPlanOverride、onSpawned、原 helper 与 scratchDir 投影保持。三个 normal production 调用方不能默认导入它。既有测试的 runFn fake 在明确的测试/native compatibility adapter 中组成完整执行与释放 family，不能给 normal application 增加缺成员兜底；原测试输入、断言、预算及 getter/read 时点都保留。原规则测试只跟随真实 owner/address，不改变 classifier、断言或数值预算。

新增 hosted 回归覆盖非本机引用贯穿真实三个调用方、选中 family/receiver 不变、Intent 保留与释放结果、Memory 同 scope 补问和原 deadline/退出策略、Narrative 结果与解析、两协议 native compile/bind 和同族 runtime 绑定。SQLite/PG 的真实根与 Intent queued resumption 同批有完整选择覆盖；Windows push/PR 的 path 与执行列表对称登记。所有既有 native/core/preparation 回归继续参加 hosted CI。

实施前做有限独立设计门；完成源码后做有限独立功能门和纯 AST/字节保持证明。仅对本任务文件做可选 format/lint，不运行本机 AW tests/typecheck/build/service。只在冻结且有效的源码候选上运行一次原 canonical 生成，排除并保留其他会话 WIP；匹配正文门与 exact-path publication 单独验收。status.md 保留原 renderer 字节，不做额外 Markdown 格式投影。每笔发布分别追踪 exact-SHA hosted CI，不能用原批次或另一个分支的绿替代。

三个普通入口接通后继续 RC-MCP 完整诊断族、smoke、脚本/purpose commands、H7 执行权与恢复及 A-T7 收口；独立 A-G 完成后进入必须的 CS adapters、M0 首次实际部署，再按 M1～M4 逐步接入。当前 aw 尚未在 CS 部署，RFC 保持 In Progress。

## HTTP 根的应用内容 home

HTTP Intent 原 inbound 单独读取全局 Paths.root，而同一根的材料和数据装配已有明确 appHome。完整 family 接线把这个既有数据 home 同时作为 Intent inbound 的必需装配成员：dump、文档和所选 native workspace 使用同一根的快照，inbound 不再二次选择全局 home。正式 native 部署的根 home 和全局 home 相同，原布局及业务算法保持；直接装配者显式传入不同 home 时以其根参数为准，消除原来声明的根 home 被该入口忽略的情况。这是 bootstrap 内容选择，不向正常 System request 添加物理 parent/binary。Memory 和 Narrative 保留其原全局 appHome 的晚读取；queued Intent 使用原 dispatcher 中的 appHome 快照，HTTP fake family 不进入 queued recovery。

## 第一轮源码功能门与修正

SYSTEM-SOURCE49-R1 是有效的有限 FAIL，49 owned、15 control、17 evidence 的首末指纹一致；五个 P2 与原回执完整保留。该失败不能算作源码通过。Memory 的 named workspace scope 改为每条蒸馏链只选一次，同一实例传入所有补问及最终释放；原 parent/name 的选择、deadline、session 与退出规则保持。HTTP Intent 保留原 own-property 快照，并在快照缺少新必需 family 时从原 receiver 读取一次 prototype/non-enumerable systemAgents；不会另选 native。新增真实 HTTP 创建入口回归使用 private-backed class getter、所选不透明 runtime/retention 和真实双数据库持久化；等待 dispatcher 最后一个实际 persistence 操作完成再交还 harness。

其余三个发现仅修正测试：native seed 地址补回原 worktree 层；class receiver 的严格 equality 显式给 Bun matcher 指定实际 class 泛型；Memory 首轮 request 显式收窄后用于 required release scope 的完整预期。原断言、两协议材料行为、旧测试正文及预算保持。后继 SYSTEM-SOURCE49-R2 只检视这些修正和新增 HTTP 回归，复用内容未变的上一轮检查事实；独立回执和 hosted exact-SHA CI 仍分别验收，当前未完成 A-G 或 CS 部署。

SYSTEM-SOURCE49-R2 的有效 FAIL 完整保留：原五项 P2 均已静态闭合，新 HTTP fixture 把真实 IntentSqlPersistence class 展开成普通对象，丢失 prototype 创建方法，因此实际 POST 会返回 500。R3 仅修正该测试及本记录：保留同一个完整 persistence 实例，只在这个测试实例上观察 activateWorkingSetChange；原方法 bind 原 receiver，完成通知后仍断言实际查询成功，其他 class 成员、真实创建和持久化均保持。新独立门只回访这两份 delta，47 份 owned 未变；没有本机 AW 执行、第二次源码全量检视或 CS 部署。
