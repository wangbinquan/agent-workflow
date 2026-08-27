# RFC-328 持久化任务执行所有权与 fencing（P0-D）

> 状态：Done（production，2026-08-26；用户已批准 D1～D12、能力影响 1～12 与完整 code-host recovery matrix；本次文档收口已获用户授权发布，其自身远端与 CI 由发布流程核验）
> 目标架构位置：RFC-294 N2 / P0-D；硬前置于新号 W2 implementation RFC
> 落地证据：主实现 `650ced2528fcf16c48e1743127394463ca747dc5`，修复链收口于 `6af560df7`；两者均为 hosted-green containing SHA `5c762c19715f167a8796bf08d661ad9c43b4349f` 的祖先。CI run `32998902223` 与 visual run `32998902239` 均为 `success`。本 RFC 只完成 P0-D，不领取 W2 credit。

## 1. 背景

RFC-294 的 N1/W0-R 机器治理基线已经完成；下一项明确排定的是 P0-D：让“谁可以继续驱动一个任务”从进程内约定变成持久、可 fencing、可恢复的事实。

当前生产实现有三套互相补位、但没有共同线性化点的机制：

1. `InMemoryTaskDriverSupervisor` 以 `taskId → AbortController + process generation` 记录本进程 handle；daemon 重启后全部丢失。
2. `services/driverLease.ts` 以另一张进程内 Map 只保护 auto-resume / auto-repair / heartbeat-kill / periodic-reconcile；人工 resume/retry 不 acquire 它。
3. `runTask` 以 `tasks.status: pending → running` CAS 充当 scheduler claim；人工 resume/retry 又先以 terminal/awaiting → pending CAS 当“ownership lock”，随后在注册新 driver 之前执行进程清理、Git rollback、placeholder mint 等动作。

它们各自解决过真实事故，但组合起来仍不能回答以下问题：

- 当前 owner 是哪个 daemon/worker、是第几代？
- 旧 worker 在 lease 失效后迟到写 DB，如何由数据库而不是调用约定拒绝？
- daemon 崩溃在“外部动作已经开始、PID/工作区回执尚未落库”之间时，下一代凭什么证明可以接管？
- 人工 resume、自动恢复、scheduler kick 同时到达时，谁是唯一执行者？
- cancel/source-terminal 要停的是刚才失效的 epoch，还是后来已经接管的 successor？

当前源码把这些缺口写得很直白：

- `b8c24a5c:packages/backend/src/services/driverLease.ts:1-19` 明示它只是 in-process、人工路径不 acquire，完整原子性仍需 task ownership epoch。
- `b8c24a5c:packages/backend/src/services/scheduler.ts:740-751` 仍把 task status CAS 称为 driver claim。
- `b8c24a5c:packages/backend/src/services/task.ts:269-291` 的 attach 只对拍 task 状态、source fence 与进程内 registry。
- `b8c24a5c:packages/backend/src/services/task.ts:359-361` 的 `abortAllActiveTasks(reason?: string)` 仍允许省略 shutdown reason。
- `b8c24a5c:packages/backend/src/services/runner.ts:1728-1746` 在 PID 回执写库失败时只告警并继续健康 child；daemon 此刻崩溃，恢复侧没有完整证明。
- `b8c24a5c:packages/backend/src/services/execution/managedProcess.ts:316-345` 先写 stdin、后 await `onSpawned`，回执还被定义为 best-effort。

RFC-287 已落的仓库准备与 assembly 行为、RFC-303 已落的 source-terminal/supervisor 行为都不回滚。本 RFC 只做前向 correctness 修复：建立唯一 durable authority，并让既有路径受它约束。

## 2. 目标

- **G1 单一持久 authority**：每个 task 任一时刻至多一个 current `(ownerId, epoch)`；进程 registry、status、auto lease 都不再证明 ownership。
- **G2 统一 continuation**：`startTask / resumeTask / retryRepoPreparation / retryNode` 四个 kick，以及 auto/recovery，先写同一种 durable intent；真正 worker 再 claim，HTTP/MCP/request thread 不伪装 worker。
- **G3 DB stale-write fence**：execution-plane 的 task/node/run/output/receipt mutation 在同一 SQLite transaction 内校验并推进 current epoch；旧 epoch 的写入零落库。
- **G4 外部效果 record-before-act**：task-owned FS/Git/process 与非幂等 outbound mutation 先记 logical effect，再原子取得它触及的全部资源 fence、重验 epoch、执行、按同 epoch 结算 receipt。
- **G5 精确 handle control**：runtime registry 只缓存 `{OwnershipToken, ActiveTaskHandle}`；stop/detach 都按 exact token，不能用 taskId 误杀 successor。
- **G6 可证明恢复**：lease expiry 只触发恢复，不单独授权 takeover；旧 handle/process 无法证明已停时进入 `recovery-required`，绝不双写。
- **G7 行为保真**：保留 RFC-287 的 deferred repository preparation、窗口重试、四 kick、RFC-303 source fence、RFC-202 daemon shutdown→interrupted、call child 与 workgroup 行为。
- **G8 机器闭合**：把 task-execution writer 与 FS/Git/process/非幂等 outbound effect 的完整分母纳入 RFC-294 canonical manifests；任何新增未分类写点/effect 当场红。

## 3. 非目标

- 不做 W2 的 task↔scheduler 解环、目录搬迁或 `TaskEngine → WrapperRuntime → NodeExecutor → ExecutionKernel` 四级物理切分；本 RFC 只提供 W2 必须复用的 ownership authority。
- 不做 W3 committed-event/outbox 全量 cutover；本 RFC 只要求 ownership invalidation 与既有 lifecycle event 同事务，post-commit stop 保留可恢复回执。
- 不完成 P0-C human-gate 全域原子化；review/clarify/questions 的内容模型仍归 P0-C。本 RFC 只要求它们不能直接取得 worker authority，且 continuation/control 带 expected revision。
- 不新增 multi-daemon 产品形态、远程 worker 调度或集群选主。协议不依赖“Map 恰好唯一”，但本次产品仍由 daemon PID lock 保持单实例。
- 不改变 `TaskStatus` / `NodeRunStatus` 枚举，不新增前端页面或人工“猜远端结果”的裁决入口，不改变 REST/MCP 的成功响应形状；只新增 bounded safe error，并在结果未知时收紧同一因果 execution lineage 的 continuation/retry。
- 不把 pre-admission 的 multipart/fusion/pre-created workspace 强行改成 task 第 0 步。任务行提交前仍由既有 one-shot materialization cleanup token 独占；提交后的 handoff 才进入本 RFC authority。把全部 materialization 改成 post-admission 属 W2-B。
- 不造通用 platform lease/generic saga engine；ownership、intent、effect/attempt/fence、maintenance 与 lineage replay-decision 数据只属于 `task-execution` bounded context。
- 不把 agent/script 子进程内部任意网络行为伪装成平台可逐请求 exactly-once；本 RFC journal 的 outbound mutation 仅指 daemon 通过受管 code-host/integration port直接发出的写。子进程整体由 process effect fenced，其内部不可观测副作用仍按 runtime/tool 自身合同处理。
- 不解决 W5 source-control owner、W7 NodeRun v2 identity 或 W9 managed background registry。

## 4. 用户与系统故事

- **US1 人工与自动恢复竞争**：用户点 resume 的同时 auto-resume tick 到达，两边都只提交 continuation；数据库只允许一个 intent/epoch 被 claim，另一方不触碰工作区、不 mint placeholder、不 spawn。
- **US2 daemon 崩溃**：worker 已记录 process effect、刚 spawn 就崩；新 daemon 先按 durable effect + PID/binary/reap 证据恢复。证明不了旧进程已停时，任务停在可诊断的 recovery-required，而不是启动第二个 writer。
- **US3 stale worker**：epoch 7 在网络/事件循环停顿后恢复执行，但 epoch 8 已合法接管；epoch 7 的 node settle、output、terminal commit 全部因 DB fence 返回 stale，零 receipt。
- **US4 精确取消**：cancel 事务使 epoch 7 失效并提交 lifecycle event，事务后只 abort registry 中 exact epoch 7；即使 epoch 8 后来出现，也不会被 taskId-only stop 误杀。
- **US5 优雅停机**：daemon shutdown 用不可省略的 `daemon-shutdown` reason abort 全部本地 handle；正常结算为 interrupted。预算耗尽的 survivor 被 invalidate/recovery，而不是由无 token 的裸 status write 冒充已经停止。
- **US6 inherited workspace**：call child 使用父任务工作区时，父/子不同 task epoch 仍竞争同一个 workspace fence key；父等待期间让出效果锁，任何时刻只有一方执行 FS/Git/process act。
- **US7 网络响应丢失**：code-host 已接受 comment/approval/merge 等非幂等 mutation、响应却在 receipt 前丢失；恢复侧先按已批准 binding 声明对账。能证明已发生就 adopt、能证明未发生才在同 operation generation 创建下一 attempt；始终无法证明时，把本轮 task 以 `execution-effect-outcome-unknown` 收口并在因果 lineage 写 `requires-actor`，仅暂停无 actor 的自动重放。用户随后执行既有 manual node/parent retry，即在同一 command transaction 显式授权下一 operation generation；平台不永久封禁该能力。
- **US8 终态维护竞争**：archive/delete/retention/workspace GC 在任何外部 IO 前原子冻结完整 task tree并取得 durable maintenance claim；resume 与维护谁先提交谁赢，loser 得到 typed conflict。daemon 在导出、删库或清理磁盘之间崩溃时，恢复侧继续 exact claim，而不是留下“任务还在、文件已搬走”或“DB 已删、cleanup 丢失”的半状态。

## 5. 待批准决策

| #   | 决策                               | 本 RFC 选择                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 持久模型                           | 新增八张 task-execution-owned 表：owners、intents、effects（稳定 operation family + actor operation generation）、effect_attempts（一次真实 act/send 一代）、effect_fences（attempt 的多资源 holds）、maintenance_claims、maintenance_members、lineage_operation_records。第八表是无task FK的retained discriminated ledger：每个family一条单调`generation-watermark`，每个unknown generation另有一条`replay-decision`；前五表随task hard delete，maintenance两表与operation ledger不级联。record中的source/bound/new-effect/anchor ID全是soft ref。每次settle同事务推进watermark，故known/succeeded child被删除后parent retry仍从N推进N+1；未决decision correctness-indefinite保留，consumed与无anchor watermark只原位compact为仍保留causal key/highest-generation/slot digest的tombstone；不把lease字段塞进`tasks`，不复用别域lease表                                                                                                                                                                                                                                                                                                                  |
| D2  | worker identity / module lifecycle | daemon bootstrap 唯一拥有一个 `TaskExecutionModule` 与不可构造的 generation/factory，每次 ownership claim attempt 铸新 `WorkerIdentity`；app/ticker 只借用同一 module，HTTP/MCP/body/env 均不能传 `ownerId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | 四 kick 语义                       | start/resume/retry-prep/retry-node 与 auto/recovery 全部先写 durable intent；request thread 不做 rollback/mint/spawn，worker claim 后执行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D4  | DB fencing                         | 所有 execution-plane mutation 必经 `withOwnedTaskTx`；同一事务先以 exact `(taskId,ownerId,epoch,state=claimed)` CAS 推进 owner revision，再做领域写                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D5  | 外部效果                           | FS/Git/process/非幂等 outbound 使用稳定 operation family + actor operation generation + 单调 effect attempt；每次真实 act/send 都独立 `prepared → acting → succeeded/failed-not-applied/retry-authorized/recovery-required/outcome-unknown` 并原子 acquire 全部真实资源 key。在同一 operation generation下创建`attempt+1`只允许三种已登记authority：probe证明未执行、D10 matrix冻结的现有transport retry policy，或确定性convergent recovery；transport policy允许下一send不等于证明上一send未发生，任一旧ambiguity都必须进入聚合结论。后续attempt明确applied时保持既有成功语义，但receipt/audit保留`prior-ambiguity`且不声称exactly-once；若只有后续明确失败而旧ambiguity未收编，logical outcome仍unknown。每个generation settle必须同事务CAS推进retained family watermark；新generation只能取live effect与watermark共同最大值+1。**任何现有actor manual node/parent cascade retry都为其选中scope创建下一operation generation**，包括此前succeeded且child后来被hard-delete的下游；wrapper continue/resume仍保持同generation。unknown generation还必须按D11消费decision。每个act前重验epoch，receipt/终止结论只能由同epoch或受控recovery resolution结算 |
| D6  | takeover / outcome-unknown closure | `released` owner 可立即新 claim；`revoked/recovery-required` 只有两条私有 authority 出口：确定性 takeover proof 可结算旧代并 `epoch+1`；task-wide `VerifiedOutcomeUnknownClosure` 必须绑定 exact owner revision与完整 unresolved effect-attempt/hold/handle/node-run 集合，先 stop/await 全部本地执行面、逐 effect probe，确认所有handle/process stopped、所有非unknown sibling terminal，且待收口unknown attempts与其exact holds集合冻结并可在同一transaction结算。随后该transaction才把unknown generation/attempt记为`outcome-unknown`、释放其exact holds、终止本轮task并release owner。它本身不创建recovery intent/epoch；之后actor显式manual retry可按D11重新授权，任一sibling不可停止则仍保持recovery-required                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D7  | cancel 顺序                        | actor/status/revision 校验、task terminal transition、owner `claimed→revoked`、event append 同事务；提交后在module内先为exact old token写sticky stop，再等待该token的claim→attach permit完成attach或补偿。stop先到则后续attach被拒绝/立即关闭；attach先到则stop exact handle。只有permit drained + stop/reap/probe成功才`revoked→released`，否则recovery-required；绝不把“当前尚无handle”冒充“资源已释放”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D8  | 对外兼容                           | 不要求现有客户端新增 revision 字段；inbound adapter 在已授权读后绑定 internal required expected revision。未来若做客户端 stale-view OCC，另立 wire RFC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D9  | cutover/回滚                       | 不运行双 authority shadow mode；新协议一次切换。schema 可保留，但升级后不得让旧 binary 在同一 DB 上继续执行任务；故障时停 admission、保留账本并 forward-fix，二进制降级需恢复升级前备份                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D10 | 不确定 outbound mutation           | 请批快照必须包含完整 [`code-host-recovery-matrix.md`](./code-host-recovery-matrix.md)：29 actions逐 provider/candidate 与 custom method 的 class、classifier、probe、fallback、依据和能力影响。原则是**不以安全名义收缩既有功能**：current built-in优先用exact-object/convergent/partial probe保留能证明的自动恢复，其余进入actor replay而不删除manual能力；`mr.approve`不改变normal request或引入HEAD pin/409，response-loss后因current请求未冻结HEAD而走R-ACTOR，正常成功、既有429与manual retry全保留；`custom GET/PUT/PATCH/DELETE`继续现有method-derived网络/5xx重试，所有custom method继续遵守现有429/Retry-After重试，POST不新增其他自动重试。每次真实HTTP send都记录为effect attempt；transport policy可授权下一send但不能抹掉此前ambiguous attempt，聚合结果仍无法判定时只停止无actor的自动重发并转`outcome-unknown`，manual retry权按D11保留。classifier与fake provider oracle分离，错误声明必须被变异测试咬红                                                                                                                                                                                                                                |
| D11 | outcome-unknown 后续权             | replay decision绑定root lineage + immutable ancestor slot path + operation family key + unknown operation generation，而非taskId；同表family watermark为known/unknown共同提供最高代次。授权allowlist只有具名actor发起的现有`retry-node`（含选中cascade）、`retry-repository-preparation`（仅prep scope）、manual `resume`（当前failed/interrupted frontier）与manual `sync-workflow`（同步后可达scope）；scheduler/auto/boot/recovery/source event及gate/clarify/question answer都不能因“有actor”自动授权。command transaction从retained slot path+watermark冻结selected next generation，铸`replay_authorization_id`、原子授权全部命中decision并绑定initiating intent；worker或其proof-backed recovery successor凭同authorization创建下一operation generation/attempt 1并consume。任何terminalize-intent事务都必须处理bound-but-unconsumed decisions：有exact recovery successor则同事务rebind，无successor且零新attempt则退回`requires-actor`，已有attempt却未consumed是invariant violation/recovery-required。旧unknown effect/attempt永不重开或覆盖；完全独立root生成新lineage并照常允许。本RFC不做provider-object全局封禁                          |
| D12 | terminal maintenance               | archive/delete/retention/workspace GC 在外部 IO 前用 maintenance_claims/members 单事务冻结完整 cascade/resource-owner set，逐 task重验 terminal、owner released/absent、unresolved attempt=0，并先结算所有bound-but-unconsumed replay authorization；continuation admission拒绝 active member。最终 DB transaction匹配 exact claim/revision；hard delete逐family验证所有settled generation已同事务进入retained lineage operation watermark，保留decision/causal tombstone并把不会随 task cascade删除的 cleanup plan推进持久队列；archive在claim下导出owners/intents/effects/effect_attempts/effect_fences/lineage_operation_records**六份**自包含ledger及claim/member manifest后再exact finalize；中断按同claim恢复                                                                                                                                                                                                                                                                                                                                                                                                                                     |

实现期默认 lease TTL 为 60 秒、heartbeat 周期不超过 15 秒，均为 task-execution 内部常量并使用可注入 clock 测试。**超时本身不授权 takeover**，所以一次 event-loop 长停顿最多延迟恢复，不会制造双 writer。

## 6. 能力影响清单

本 RFC 不删除 endpoint、按钮、任务状态或成功路径，但它是 correctness 收紧，以下行为变化必须显式批准：

1. **无法证明旧进程已停止时，人工 resume/retry 将不再“试着继续”**；它返回/呈现 `execution-recovery-required`，直至 recovery probe 得到确定证据。受影响：所有部署形态，主要是 daemon 崩溃或 unkillable child 后的任务。
2. **同一任务的并发重复命令只允许一个 continuation**；loser 得到 409 或读取 winner，不再靠时序偶然执行一半。受影响：REST、MCP、网页、auto/recovery 同时操作同一 task。
3. **旧 epoch 的迟到 output/event/terminal receipt 被拒绝**；日志会记录 stale code，但不会把“其实已经发生的外部动作”伪造成已结算。受影响：超时恢复、daemon handoff、长暂停后的 worker。
4. **升级后的数据库不能原地运行旧 binary 的 task execution**；旧 binary 不懂 epoch fence，允许它继续写会重新打开本 RFC 关闭的窗口。受影响：运维降级流程；正确方式是停机并恢复升级前备份。
5. **`ownerId`/epoch 永不成为外部可提交字段**；没有“管理员手填 owner 强行接管”逃生口。恢复只能由受控 probe 证明后 CAS。
6. **terminal maintenance 与 continuation 互斥，且冲突可能是无限期而非“暂时”**：archive/delete/retention/workspace GC与resume谁先取得durable claim谁赢，loser得到409/claim reference。unkillable process或未知 FS/Git identity没有管理员 override时，维护、删除与磁盘回收可能永久保持 recovery-required。受影响：取消后立即归档/删除、terminal workspace GC、运维磁盘保留。
7. **非幂等outbound模糊结果只暂停无actor的自动重发，不取消人工重试能力**：task先以`execution-effect-outcome-unknown`失败并在既有task/node failure detail显示“远端结果未知，继续可能重复动作”的safe diagnostic；用户随后点击/调用D11 allowlist内既有manual retry/resume/sync即视为显式重新授权，可继续同causal lineage。受影响：极端失败窗口会多一条风险提示/审计，但不新增确认弹窗或必填wire字段，按钮、endpoint和操作能力保留。
8. **built-in code-host mutation的现有成功与重试能力原则上保留**：exact-object可探测/可收敛动作由matrix继续自动恢复；创建类动作至少保留既有429重试和manual retry，不新增笼统永久封禁。受影响：恢复实现会多probe/attempt记录，正常交互不减。
9. **`custom`重试语义保持当前行为**：GET/PUT/PATCH/DELETE仍按现有网络/5xx规则，所有method仍按现有429/Retry-After规则；POST不新增网络/5xx自动重试，manual node retry始终可用。平台记录每次send与unknown审计，但不替workflow作者改写其HTTP语义。
10. **replay guard不是provider-object全局封禁，也不去重正常人工重跑**：同lineage的auto必须停下等待actor授权；manual parent/child retry会给选中scope内所有重跑动作（包括此前succeeded的cascade下游）分配下一operation generation。即使child及其live effect已hard delete，parent cascade也从retained family watermark读取最高settled generation `N`并创建`N+1`，不会错误回到0或复用旧代。完全独立root仍可再次写，即使目标provider object相同。需要全局去重的业务应使用provider/业务幂等合同，本RFC不以安全策略猜测用户意图。
11. **retained lineage operation record带来小体积、correctness-indefinite保留**：每个settled operation family都保留一条单调generation watermark；每个unknown generation另保留一条replay decision。只要任一root/ancestor/current task仍可通过现有入口继续该lineage，`requires-actor`与未消费authorization就不能按年龄GC；全部anchor消失后，consumed decision与无anchor watermark也只原位压缩为仍保留causal key、highest generation、slot digest与必要审计摘要的tombstone。受影响：数据库会按operation family长期保留bounded无secret记录，增长与settled family数而非attempt/body大小相关，以换取known/unknown child已删除后parent retry仍可从正确下一代继续且不误授权别的分支。
12. **只有明确的人工 continuation命令授权 replay**：manual retry-node/retry-prep/resume/sync按各自既有scope授权；gate/clarify/question answer、scheduler/auto/boot/recovery/source event不授权。受影响：用户仍使用原按钮/API/MCP命令，无新增必填字段；若只是回答人工门，系统不会把该回答暗中解释为“同意再发一次远端写”。

未受影响：创建/取消/恢复/重试的既有 URL 与权限；Task/NodeRun wire；deferred repository preparation 的用户可见阶段；RFC-303 source-terminal 保护；daemon shutdown 的 interrupted 语义。

## 7. 核心行为合同

### 7.1 三种状态彼此独立

| 事实                       | 回答的问题                             | 权威                                    |
| -------------------------- | -------------------------------------- | --------------------------------------- |
| task/node lifecycle status | 业务进行到哪一步                       | 既有 lifecycle domain + CAS             |
| durable ownership          | 谁可提交 execution-plane mutation      | `task_execution_owners` current epoch   |
| process-local handle       | 本 daemon 能否 signal/await 哪个进程树 | `TaskRuntimeRegistry` exact token entry |

`task.status='canceled'` 不证明进程已停；registry 里有 handle 不证明它仍是 current owner；lease 过期也不证明旧 child 已死。

### 7.2 intent 是唯一启动依据

任务第一次启动、恢复、准备重试、节点重试、同步后续跑、gate continuation 与 recovery 都形成 immutable intent。一个 task 最多一个 `pending|claimed` intent。worker 同一事务 claim intent 与 ownership，随后获得不可序列化的 `OwnershipToken`。

### 7.3 stale 只允许读，不允许结算

旧 worker 可以完成一个已经出手且无法撤回的外部动作，但它不能：

- mint/settle node run；
- append authoritative output/receipt；
- 推进 task frontier/status；
- 把 effect 标成 succeeded；
- release 或 stop successor。

恢复侧读取 effect-specific evidence 后决定 adopt/compensate/retry/recovery-required，不能相信旧 worker 的迟到回调。

## 8. 验收标准

### Authority / claim

- **AC-1** 同一未认领 task 的两个并发 initial claim，恰好一个成功；owners 表只有一行、epoch=1。
- **AC-2** released 后的新 claim 与经 recovery-proof 完成的 revoked/recovery-required takeover 都严格 `epoch+1`；owner epoch 永不 delete/reset/reuse。
- **AC-3** `ownerId` 只能由 bootstrap worker factory 铸造；HTTP/MCP/schema/route payload 零字段、零反序列化路径。
- **AC-4** heartbeat 只续 exact owner/epoch；epoch 已前进时返回 typed stale 并触发本地 abort。
- **AC-5** lease expiry但旧 handle 未证明停止时，takeover 为零，owner 进入/保持 recovery-required。

### Intent / command

- **AC-6** start/resume/retryRepoPreparation/retryNode 四个 kick 全部产生同一 canonical intent 形状并走同一 claim use case。
- **AC-7** manual/auto/recovery 竞争只有一个 active intent；loser 在任何 FS/Git/process/outbound/node mint 前停止。
- **AC-8** resume/retry request transaction 只做授权、expected revision CAS、状态/intent 写；rollback/reap/placeholder/spawn 全部在 worker claim 后。
- **AC-9** intent commit后、claim前丢wake或daemon崩溃时，boot orphan barrier把task转`interrupted`并在同一transaction把active intent终止为`failed/daemon-restart`；旧active unique不阻塞后续。现有manual resume/retry或已启用的`autoResumeOnBoot`随后通过同一command path提交fresh intent，零scheduler-less pending zombie，也不在缺失原始runtime deps时盲claim旧payload。

### DB mutation fence

- **AC-10** task lifecycle、node lifecycle、node mint、frontier/wrapper progress、outputs/events、workspace/process receipts 与 worker terminal commit 均要求 `OwnedTaskTx`。
- **AC-11** 每次 owned mutation 在同一 transaction 先 CAS exact token并推进 owner revision；故障注入证明 CAS 失败时领域表零写。
- **AC-12** epoch N 的失效线性化点之后，连接级 statement/transaction trace按 token证明 N 的每个 stale callback在 fence CAS affected=0 后零领域 statement commit；不能只比较最终 row/content hash。失效前合法历史保持不变，epoch N+1 的写不被旧 release/stop 影响。
- **AC-13** control/gate mutation 使用 required internal expected task/node/gate revision；不能构造 `WorkerIdentity` 绕过控制面。

### FS / Git / process fence

- **AC-14** 每类 task-owned FS/Git/process/非幂等 outbound effect 都有 canonical denominator，且每次执行顺序是 durable operation family/generation → monotonic attempt prepared → all-resource fence acquire → epoch recheck/acting → act → same-epoch/recovery-proof receipt。
- **AC-15** effect attempt以多值资源集原子 acquire；每个 fence key同时acting attempt≤1。process key使用稳定effect-attempt/node-run identity而非`process:<taskId>`，故独立agent/script process仍可并行；workspace/iso/root key约束真实共享写面，sibling isolation可并行但merge root共享，`spaceKind='inherited'` child使用真实borrowed call-node iso key。
- **AC-16** process spawn 前已有 effect intent；PID/binary/process-group receipt 写失败时立即 TERM→KILL→reap，不能继续健康 child。
- **AC-17** crash在spawn/act与receipt之间时，attempt保持unresolved；新owner只有在全部effect-specific probe与task-wide quiescence证明旧执行面已停止后才能接管。`outcome-unknown` closure必须覆盖完整task集合；任一sibling process/attempt未停则owner不released。closure后D11 allowlist内actor manual continuation仍可创建下一operation generation与首个attempt。
- **AC-18** unkillable/unknown process 使 ownership/effect 进入 recovery-required，且不会启动第二个 process/workspace writer。
- **AC-19** operation family identity、slot path与request hash跨intent/epoch保持稳定；每个known/failed/unknown logical settle都在同一transaction以CAS推进retained family generation watermark，新generation严格取`max(live effect generation, retained watermark)+1`。probe、convergent recovery或已批准transport policy在同generation创建`attempt+1`并实际完成下一次act/send，authority逐attempt冻结。actor retry-node(cascade)对target及每个已完成下游都创建`operation_generation+1`并真实再act；wrapper continue/resume不错误加代。必须有组合fixture覆盖“child generation 0成功→child local retry generation 1成功→hard delete child/live effects→parent cascade创建generation 2并真实再act”。unknown generation只有exact authorization可推进。transport-authorized retry不把旧ambiguity改写成failed-not-applied；logical settle汇总全部attempt：later applied仍成功并留prior-ambiguity audit，later failure不能抹掉旧ambiguity。旧attempt/hold历史不可覆盖且不能释放新attempt；跨intent同operation不同hash fail closed。

### Stop / shutdown / recovery

- **AC-20** registry attach/get/detach/requestStop 全部按 exact token；生产代码不存在 taskId-only stop。
- **AC-21** cancel/source-terminal 同事务令 old epoch `claimed→revoked`，terminalize intent时把零attempt的bound authorization退回`requires-actor`；提交后先为exact old token写sticky stop，再排空覆盖durable claim commit→exact registry attach/补偿的permit。stop先到时后续attach被拒绝或立即关闭，attach先到时stop exact handle；只有exact permit drained且stop/reap/probe成功才可产生`VerifiedStopProof`并released，“当前没有handle”本身不是释放证据。barrier fixture必须把cancel/source terminal放在claim commit与attach之间。archive/delete/retention/GC在任何外部IO前必须取得覆盖完整task/resource set的durable maintenance claim并证明无悬空authorization，continuation与重叠维护loser零副作用。
- **AC-22** daemon shutdown 的 `abortAll(reason)` reason 非可选；closable claim→attach gate 先 seal并排空 in-flight，再 snapshot stop并最终 sweep current generation，既有 interrupted/daemon-restart oracle保持。
- **AC-23** same-daemon takeover与new-daemon在持有exclusive daemon lock后先做的exact`claimed→revoked`都产生proof revision；窄`recovery-proof` authority在单事务核对exact old owner/proof revision、结算旧intent/effect attempts并推进epoch+1。terminalize旧intent时，bound decisions要么rebind exact recovery successor、要么零attempt退回requires-actor；decision ID/revision纳入proof digest，部分consume不可悬空。task-wide `VerifiedOutcomeUnknownClosure`只有在完整owner/effect/attempt/hold/handle/node-run/decision digest仍匹配且全部本地执行面已静默时才允许task failed + replay-decision + owner released，无法被当作takeover proof。
- **AC-24** crash matrix除七个execution窗口外，覆盖new-daemon exact revoke commit前/后、authorization command commit、intent claim、第一/第N个decision consume前、多decision部分consume、cancel/source/shutdown terminalize、cancel commit→stop前→maintenance、maintenance claim→archive move/delete transaction→retained cleanup及outcome-unknown closure与sibling process/outbound并行窗口。

### Compatibility / architecture

- **AC-25** RFC-294 task-execution compatibility oracle四条、RFC-287 repository-prep/assembly、RFC-303 runtime ownership/source-terminal 全部保持。
- **AC-26** `TaskStatus` / `NodeRunStatus` / Task REST/MCP wire零breaking delta；只新增内部列与现有failure detail中的safe diagnostic。前端沿用既有retry/resume/sync控制，不新增确认弹窗或必填字段。
- **AC-27** `services/driverLease.ts` 不再有生产 consumer；`isTaskActive` 只允许观察/测试，不能出现在 admission/fence 判据。
- **AC-28** canonical mutation manifest 对所有 execution-table writer逐项分类为 `worker-epoch / control-revision / recovery-proof / terminal-maintenance`，未分类=0；`control-revision`再以discriminated subtype完整覆盖`continuation-admission`、既有terminal/gate/membership control、`daemon-shutdown`与持有branded exclusive PID-lock proof的`recovery-candidate-revoke`。每个subtype都有精确允许表/转换/revision谓词与禁止写面，四个顶层kind总和及各subtype总和都必须等于current writer denominator。
- **AC-29** canonical external-effect manifest 对 task-owned FS/Git/process/非幂等 outbound act逐项登记 journal/multi-fence/recoveryClass/responseClassifier/probe-or-actor-replay/transportPolicy/auditRetention，未登记=0；守卫含非空语料与负 fixture。
- **AC-30** 本 RFC 不新增 task↔scheduler 拓扑债、不新造第二套 lease/schema、不计 W2 wave credit；W2 只复用这里的 authority。
- **AC-31** production 每 daemon 恰好一个 TaskExecutionModule；HTTP/MCP、scheduler、ticker、recovery、shutdown观察同一 module ID，重复构造 fail fast，module 提供 `dispose()/awaitIdle()`。
- **AC-32** 请批hash包含完整action×provider×candidate矩阵；read/unsupported显式排除，built-in按exact-object/convergent/partial-probe/manual-replay分类，custom严格锁住current method+429语义。`mr.approve`两provider因current request未冻结HEAD归`R-ACTOR`：正常请求/成功/429/manual retry保持，独立fixture分别覆盖response-loss后HEAD advance、GitLab approval reset与GitHub review dismissal，禁止把新HEAD上的当前批准状态误认成旧请求已发生。独立于manifest声明的fake provider覆盖已落地后断连与rate-limit；可恢复动作副作用符合matrix，custom调用次数与当前合同一致。早期ambiguous send后later applied保持成功并留prior-ambiguity audit；later failure不能把logical result伪装成definitely-not-applied。unknown后task-wide closure只有在sibling全静默时才released；actorless auto重发=0，而allowlist内manual retry/resume/sync各按scope成功创建下一operation generation，gate/answer不授权。nested child hard delete/retention boundary后parent selected-scope既能精确命中unknown decision，也能从known/succeeded retained watermark取`N+1`；archive含owners/intents/effects/effect_attempts/effect_fences/lineage_operation_records六份self-contained ledger与maintenance manifest，hard delete后retained watermark/decision/tombstone/audit/cleanup job仍在。

## 9. 成功判据

RFC-328 只有同时满足以下五条才可 Done：

1. durable ownership authority 恰好 1；
2. epoch 失效后的 stale authoritative DB mutation 增量恰好 0；
3. 任一 workspace/process/outbound resource fence key 同时可写 effect attempt 不超过 1，且不把同 task独立process错误串行为1；
4. manual path 不再依赖 `activeTasks + task.status CAS` 或 `driverLease` 约定取得执行权；
5. revoked/recovery-required task的archive/delete/GC与无actor授权的同lineage unknown重发恰好0；`outcome-unknown`只可在task-wide quiescence后结算，exact-token claim→attach停止窗口无漏handle；retained lineage operation records同时保住可跨child-delete解析的unknown decision与所有settled family最高generation，new-daemon/recovery/terminalize不存在悬空authorization；actor manual retry/resume/sync及普通cascade重跑能力与现有custom/built-in重试合同不被安全策略删除，archive自包含、maintenance中断可恢复。

达到这些判据后，才允许创建 N3 的新号 W2 implementation RFC。
