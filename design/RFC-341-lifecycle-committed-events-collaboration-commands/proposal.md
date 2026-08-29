# RFC-341 — 生命周期已提交事件与协作命令收口（RFC-294 W3）

- 状态：Done（2026-08-30；完整 W3、canonical replay 与 exact-SHA hosted closeout 已完成）
- 发起：RFC-294 W3 successor，2026-08-29
- 开工 source pin：`1947e1ad02d3eb3f8a0c062f2a2f42a1ce5f61ce`
- committed-event foundation / task cutover / collaboration cutover：`19fba75442786210b0a0deab3f7795a8e1e0196f` →
  `3bfa9d447e9d61d6dc4336771f093bd06055c066` → `5318db02d18ce321ed37317d1265020e1feab687`
- durable clarify convergence / recovery lock：`275f661b73495971864bfd12d22707ab5466d3ef` →
  `acb518f81337b19633b39081265ad75259baea51`
- idle dispatcher contention repair / published exact SHA：`8f95c423fb594105cc136324e3b2f20397a465ed` →
  `67a97480c5944c723d3ee08490631e4db768a5c6`
- current canonical payload / provenance：`f94290d715365ee6c46e927c211a00326834157b` →
  `d2a4cc742c6dbb318b237ede15155b354cd79584` → `67a97480c5944c723d3ee08490631e4db768a5c6`
- current canonical source digest：`sha256:3714450fee40135133fb94fb846d6f4f32369d00625d8f7249e6049a80c73805`
- published exact SHA / Main CI：`67a97480c5944c723d3ee08490631e4db768a5c6` /
  `33268925250`（terminal success）
- 前置：RFC-328、RFC-331、RFC-332、RFC-333、RFC-334、RFC-339 均已完成
- 范围：task lifecycle committed events、review / clarify / questions collaboration committed events、
  内部 consumer、持续 continuation、Event Center 运维可见性
- 授权边界：用户已明确批准完整实施并提交上库；本 RFC 只关闭 RFC-294 W3，不自动授权 W4 以后 wave

## 0. 终态一句话

把当前“事务已提交，但随后靠散落 callback、内存 watcher、request-owned wake 和 direct WebSocket broadcast
继续推进”的路径，收成两组 producer-owned closed committed events、同事务持久事实、按 consumer 独立记账的
durable delivery，以及持续运行的 continuation worker；同时保持用户已经能观察到的顺序：

```text
DB commit
  < immediate WebSocket projection / worker nudge
  < HTTP command response
```

如果进程恰在 commit 后崩溃，后台 worker 从 durable row 恢复；正常请求不再亲自 claim 或 drive continuation。
Event Center 继续作为唯一运维入口，增加 producer publication、内部 consumer、失败原因与人工重试视图。

## 1. current-source 事实

### 1.1 W3 不是“从零造 outbox”

当前代码已经有一条可用 pilot：

| 事实                | current source                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| task status 单写    | `services/lifecycle.ts` 的 `writeTaskStatusTx` 递增 `lifecycleEventRevision`                                                |
| 同事务 append       | `enqueueTaskLifecycleEventTx` 写 `task_lifecycle_event_outbox`，唯一键为 `(taskId, revision)`                               |
| durable publisher   | `sqliteTaskLifecycleEventPublisher.ts` 已有 claim、lease、retry、dead-letter                                                |
| closed public event | `task-execution/public/events.ts` 已定义 `platform.task-lifecycle` / `platform.task.status-changed` v1                      |
| Event Center        | publisher 把 observation 送入 Event Center，后者已有 per-subscription delivery 状态                                         |
| 原子性证明          | `rfc310-task-lifecycle-events.test.ts` 与 `rfc333-task-participants.test.ts` 已锁 status / gate transition 与 outbox 同事务 |

因此 RFC-341 的工作是把 pilot 提升为 canonical committed-event chain，补齐 consumer、协作事件、切换与恢复；
不能另起第二套“全能事件总线”，也不能把现有 outbox 当作不存在。

### 1.2 task lifecycle 仍有 ambient side channel

| 当前路径                                          | 问题                                                                   | W3 归宿                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `services/task.ts::emitTaskStatus`                | transaction 外直接发 task list、task status/done、node canceled frames | task committed event 的 WebSocket projection        |
| `webSocketTaskStatusPublisher.ts`                 | 与前者存在第二套 task-status WS producer                               | 删除，统一消费 committed event                      |
| `registerTerminalTaskHook` / `notifyTaskTerminal` | 单进程 callback；终态推进依赖 ambient wiring                           | critical durable consumer                           |
| `executionWatch.ts`                               | 进程内 watcher map，虽有 DB poll fallback但不是事件 consumer           | rebuildable consumer + DB reconcile                 |
| `childBudget.ts`                                  | 进程内 singleton 由 post-commit hook 更新                              | rebuildable consumer + boot/periodic rebuild        |
| workspace prune post-commit callback              | CAS claim 已 durable，但物理执行只靠本次 callback 被及时唤醒           | rebuildable wake + existing claim reconcile         |
| `terminalSweep.ts`                                | DB sweep 后 direct node-status WS                                      | durable repair consumer，WS 仍由 event projector 发 |

### 1.3 RFC-333 已完成事务，但 continuation 仍由请求拥有

RFC-333 已完成三类人工门的核心原子性：open/decision、task/node projection、receipt 与 exactly-one
`gate-continuation` intent 都在同一事务。RFC-341 不重复这些成果。

剩余断点在事务之后：

```text
review / clarify / question HTTP route
  → collaboration command commits decision + continuation intent
  → request callback / route calls wakeHumanGateContinuation
  → current process claims intent and drives task
  → response
```

`humanGateRecovery` 当前只是 maintenance catalog 的 boot recovery。若请求 wake 在 daemon 持续运行期间失败，
没有一条持续扫描并接管 pending continuation intent 的生产 worker。RFC-341 要删除 request-owned wake，把 intent 的
claim/drive 交给常驻 worker；请求只返回已经提交的 receipt。

### 1.4 collaboration 仍直接广播

以下用户可见写操作在提交后直接调用 broadcaster，尚无 collaboration committed-event family：

- review open / selection / comment create-update-delete / decision；
- clarify open / answer / defer；
- questions dispatch / answer；
- 上述操作伴随的 node status 与 task invalidation projection。

`committedEventRef` 目前只是 collaboration operation / node-run event 中的逻辑引用，不是可 claim、retry、replay、
逐 consumer 结算的 durable event。因此本 RFC 必须把这些 direct-broadcast write 全部纳入，而不是只迁 decision。

### 1.5 Event Center 已有消费者视图，但看不到 producer failure

现有 `/events` 页面能显示 EventRecord 与 subscription delivery 的 pending / claimed / accepted / dead-letter；
task lifecycle row 如果在进入 Event Center 之前 dead-letter，则页面不可见，也没有人工 retry。RFC-341 复用此页面，
不另建运维产品。

## 2. 目标

### G1 — 两个 producer context 各有 closed event family

`task-execution` 拥有 task lifecycle event union/codec；`collaboration` 拥有 review/clarify/questions event union/codec。
任何 covered mutation 只在自己的 transaction participant 内 append，跨 context 只消费 public event，不 import producer internal。

### G2 — commit 与 event 是一个事实

每个 successful covered mutation 的领域状态、projection revision、operation receipt、continuation intent（适用时）与
committed event 在同一个 `dbTxSync` 中完成。不存在“状态成功但事件没写”或“事件写了但领域状态回滚”。

### G3 — consumer failure 彼此隔离且可恢复

每个 durable consumer 按 `(eventId, consumerId)` 独立 claim、结算、retry 与 dead-letter；同 aggregate critical
delivery 保持 sequence FIFO，某个 aggregate 的 poison event 不阻塞其他 aggregate，也不让成功 consumer 重做。

### G4 — 正常路径即时，崩溃路径 durable

正常路径在 commit 后同步完成轻量 WebSocket projection与 worker nudge，再返回 HTTP；不在响应临界区做文件删除、
长 DB 扫描或 task drive。commit 后崩溃由 worker 扫 durable row 恢复，允许同一个 invalidate frame 重发但不丢事实。

### G5 — continuation 永远归 worker

review/clarify/questions request 不再 import/call `wakeHumanGateContinuation`。持续 worker 消费已持久化 intent，支持即时 nudge、
周期 reconcile、lease/fence、daemon restart 与 current-owner handoff；command response 只表达“决定已提交”。

### G6 — 用户能力与可见顺序不退化

REST/MCP/UI 输入输出、review/clarify/questions 能力、task/node 状态、现有 WebSocket frame shape 和
`commit < publish < response` 顺序全部保持。W3 是可靠性与 ownership 收口，不借机改变产品规则。

### G7 — Event Center 成为唯一运维入口

在现有页面增加 producer event、consumer delivery、attempt/error、cutover mode 与 Retry；人工重试只重新投递所选
failed stage，不重跑原用户 command，不另建页面。

## 3. 非目标

- 不重做 RFC-333 已完成的 human-gate transaction、operation receipt 或 intent schema。
- 不迁移全平台所有 broadcaster；只覆盖 task lifecycle 与本 RFC 列出的 collaboration writes。
- 不迁普通runtime output/log stream、workgroup message或其它非W3 transport frame；只有本RFC事务实际产生的task/node状态
  projection进入committed event。
- 不实现 RFC-294 W4 route/application 全域切割、W5 source-control/completion、W6 configuration、W7 NodeRun v2、
  W9 全局 container/background registry。
- 不新增独立 Event Center 页面，不改变现有 REST/MCP/UI 的产品输入输出。
- 不把 WebSocket 当 durable source of truth；它仍是可重建 projection。
- 不在本 RFC 做任何安全类检查、加固、策略变更或测试；本轮只验证功能、恢复、顺序和用户可见行为。
- 不以“更干净”为理由删除正常能力、缩小允许输入或改变既有 audience/role 结果；相关行为只做兼容锁定。

## 4. 设计裁决

### D1 — 一份 RFC 完整关闭 W3

RFC-341 同时覆盖 task lifecycle 和 review/clarify/questions 的全部 current direct-broadcast writes。只做 task status
或只做 decision 都不能把 W3 标 Done。

### D2 — producer-owned closed union，platform 只提供机制

事件 type、schema version、payload codec、aggregate sequence 与合法 consumer matrix 归 producer context；
`platform/events` 只提供 immutable store、claim/lease/delivery/retry/cutover primitives，不拥有领域 payload，也不接受
`Record<string, unknown>` 直通。

### D3 — 同事务 append，event ID 可重算

每个 event 以 producer、aggregate、sequence、type 与 operationRef 构造稳定 id；transaction 重试命中同一 id/payload
视为同一事实，不同 payload 冲突必须使 transaction 失败。event 写入不能放在 after-commit callback。

### D4 — 保持 `commit → immediate projection/nudge → response`

covered request 在 commit 后调用窄 `AfterCommitEventPump`：只读取本次 receipt 指向的 event，完成当前 WebSocket projection
并 nudge worker，然后返回。pump 失败不得把已提交 command 伪装成回滚；route 返回 committed receipt，同时 durable worker
负责补投，错误按现有 command-result 兼容规则记录。

### D5 — continuation 的 claim/drive 不属于 request

request 的 pump 只能 nudge，不能 claim intent、调用 task driver 或等待 continuation 完成。`HumanGateContinuationWorker`
持续处理 pending intent，并对 missed nudge 做周期扫描。CLI/boot/test 也从同一 worker/显式 test harness 进入，不保留 route 特例。

### D6 — 三类 consumer

| 类别                 | 语义                                                           | 代表 consumer                                                                                   |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| critical durable     | 必须有 delivery row，失败 retry/dead-letter/replay             | Event Center publication、terminal gate close、必要领域 effect                                  |
| rebuildable durable  | event 触发加 periodic/boot reconcile；失败不能丢 durable claim | child budget、execution watch、workspace prune wake、review distill enqueue、continuation nudge |
| ephemeral projection | 正常路径立即发；崩溃后可由 DB/refetch 或 worker补发            | task list/task/node/review/clarify/questions WebSocket                                          |

consumer 的分类是闭合 registry；新增 consumer 必须明确类别、dedupe key、reconcile 与完成条件。
human-gate continuation 的 critical work identity 仍是 RFC-333 durable intent；event consumer 只负责可重建 nudge，不能再造第二份
“是否应该续跑”的事实。

### D7 — 逐 aggregate FIFO，不做全局串行

同 `(aggregateKind, aggregateId)` 的 critical delivery 只能在前序 sequence 已 accepted 后 claim；不同 task/review round
并行。projection 按 event sequence 发送；重复 invalidate 是兼容行为，倒序投影不允许。

### D8 — task pilot 迁入 canonical store，不留双系统

新增 neutral `committed_events` / `committed_event_deliveries` / `committed_event_family_cutovers` 后，先 shadow 对拍，
再按 family 原子切换。现有 `task_lifecycle_event_outbox` 的 pending/claimed/dead-letter 事实必须迁移或 drain；最终删除旧 publisher、
旧 table owner 与 direct emitter，不能永久保留两套 active dispatcher。

### D9 — collaboration command 保留 purpose-specific public API

不造一个接受任意 payload 的万能 `executeCollaborationCommand`。Review/Clarify/Questions 各保留 typed public command，
共同复用 committed-event participant、receipt 与 continuation protocol；route/MCP 只依赖这些 public commands。

### D10 — W3 worker 从出生符合 managed contract

`CommittedEventDispatcherWorker` 与 `HumanGateContinuationWorker` 实现现有 `ManagedWorkerDefinition` 的 start/readiness/health/stop
合同；周期 reconcile 以 `BackgroundJobDefinition.run` 表达。bootstrap 可先显式装配 W3 definitions，W9 再统一 registry，
本 RFC 不提前领取 W9 的全局迁移 credit。

### D11 — Event Center 原页扩展

Event Center 的 event/delivery 页面增加 stage、producer family、aggregate/sequence、consumer、state、attempt、last error、
next retry 和 Retry action。Retry 只允许 dead-letter 或明确 failed 的当前 delivery；成功项不重跑，shadow row 不可投递。

### D12 — task 独立切换，三个 collaboration family 原子共切

task lifecycle 先完成 legacy inventory、未决 outbox 迁移与独立 cutover。Review / clarify / questions 共用同一份 RFC-333
continuation ownership；若分三次启停，会在过渡期形成 request owner 与 continuous worker 的双 active 窗口。因此三个
collaboration family 先以 closed codec、transaction participant、source lock 与 fault fixture 完成 characterization，再由
migration `0222` 在同一数据库事务把三行从 `legacy/epoch=1` 一起翻到 `dispatchable/epoch=2`，并同步删除三类 request wake 与
covered direct broadcaster。历史 shadow row 仍不可 claim；dispatcher 也只能 claim current dispatchable epoch。

## 5. 能力影响清单

| 能力                                             | RFC-341 目标影响                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| task 创建、运行、终态、取消与 node canceled 投影 | 行为与 frame shape 不变；可靠恢复增强                                         |
| review open/comment/selection/decision           | 输入输出与页面行为不变；广播改由 committed event projection                   |
| clarify open/answer/defer                        | 输入输出与页面行为不变；continuation 改由 worker 持续接管                     |
| questions dispatch/answer                        | manual/auto-dispatch-deferred 行为不变；广播与 continuation 改由 event/worker |
| HTTP command latency/顺序                        | 保持 commit 后、响应前的轻量即时 projection/nudge；不等待实际 task drive 完成 |
| daemon restart                                   | pending event/intent 自动续跑，不依赖请求重发                                 |
| Event Center                                     | 原页面新增 producer/internal delivery/错误/重试；不新增入口                   |
| REST/MCP/shared schema                           | 现有用户 wire 不变；只可新增内部运维 DTO                                      |

## 6. 验收标准

- **AC-1**：source-lock 固定当前 task lifecycle writer/outbox/publisher、两套 task WS publisher、terminal hook、
  executionWatch、childBudget、workspace prune、terminal sweep、三条 request wake 与 collaboration direct broadcasts；drift 先重采。
- **AC-2**：task/collaboration closed union 与 codec registry 双向穷尽；unknown type/version、wrong aggregate、oversize payload
  和 missing consumer mapping 必须失败。
- **AC-3**：每个 covered successful transaction 恰有预期 event group；强制 outbox insert 失败时领域写、receipt 与 intent 全回滚。
- **AC-4**：同 event id 同 payload replay 幂等；同 id 不同 payload 冲突；每个 critical consumer 恰一次 accepted，失败 consumer
  不影响已成功 consumer。
- **AC-5**：同 aggregate sequence FIFO；跨 aggregate 并行；claim lease expiry、worker crash、daemon restart 与 poison event 可恢复。
- **AC-6**：正常 request 的观测顺序锁为 `commit < current WS projection / worker nudge < response`；测试禁止 response-first。
- **AC-7**：commit 后、pump 前 crash 的 task/collaboration event 最终由 worker投递；重复 projection 不改变最终 UI/DB 状态。
- **AC-8**：review/clarify/questions production route、composition 与 CLI 不再 import/call `wakeHumanGateContinuation`；
  pending intent 由持续 worker在 live daemon、restart 与 lease handoff下完成。
- **AC-9**：`emitTaskStatus`、`webSocketTaskStatusPublisher`、`registerTerminalTaskHook`、W3-covered direct broadcaster 与
  boot-only `humanGateRecovery` production owner 归零；Event Center publisher 只消费 canonical store。
- **AC-10**：task list/status/done、node status、review created/comment/selection/decision、clarify answered 与 question pending
  的现有 frame type、必要字段与可观察先后保持。
- **AC-11**：child budget、execution watch、workspace prune、terminal repair 与 review distill 均有 event nudge + reconcile；
  物理 effect 失败不回滚已提交领域事实。
- **AC-12**：Event Center 原页面可定位 producer publication 与每个 durable consumer 的状态/错误，可对 dead-letter 执行
  单项 retry；成功、shadow 或 stale epoch 不能被误重跑。
- **AC-13**：每个 family 的 shadow row 永不 dispatch；cutover 原子；pending legacy row=0 后才删旧 owner；rollback 演练不形成
  双 active delivery owner。
- **AC-14**：所有现有 task/review/clarify/questions 功能回归、fault/replay/order test 与 exact-SHA hosted CI 通过；
  本 RFC 不包含安全类门检或 findings。

## 7. 风险与控制

| 风险                                           | 控制                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 两套 event path 同时发造成重复                 | durable family cutover ledger；同一 epoch 只允许一个 active owner                                                                |
| 为保持即时性把长 effect 又塞回 request         | AfterCommitEventPump 只允许 projection/nudge，有 source guard 和 latency test                                                    |
| collaboration batch 产生半组 event             | transaction 内 event-group builder，一次编码/append，失败整体回滚                                                                |
| poison event 阻断全局                          | per aggregate FIFO、跨 aggregate并行、per consumer dead-letter                                                                   |
| continuation worker 与旧 request wake 抢 claim | 三个collaboration family shadow就绪后，在review cutover stage一次启worker并删除三类request wake；intent claim继续用durable fence |
| Event Center 把 producer 与 consumer 状态混淆  | UI/DTO 显式 `stage=producer-publication                                                                                          | consumer-delivery` |
| 旧 outbox pending/dead-letter 被遗忘           | migration/drain inventory、row-count invariant、cutover 前后对账                                                                 |

## 8. 批准记录

2026-08-29，用户在确认推荐方案后明确要求“批准实施并完整实现，然后提交上库”，据此批准 D1～D12、design §4～§13 与
plan T3～T14：包括 schema/codec、task/collaboration cutover、durable consumer、持续 continuation worker、Event Center 原页扩展、
legacy 删除与 hosted closeout。该授权只覆盖 RFC-341 / RFC-294 W3，不自动授权 W4、W5、W6、W7、W8 或 W9。

## 9. 落地与关闭记录

2026-08-30，RFC-341 已按批准范围完整落地并关闭：

- `19fba75442786210b0a0deab3f7795a8e1e0196f` 通过 migration `0218` 建立 immutable committed-event ledger、aggregate
  head、逐 consumer delivery 与 family cutover；task/collaboration closed codecs、bounded dispatcher、持续 continuation worker
  definition，以及 Event Center producer/consumer 查询、错误与单项 retry 都已接入。四个 family 此时保持 legacy，不提前切流量。
- `3bfa9d447e9d61d6dc4336771f093bd06055c066` 通过 migration `0219` 把 task lifecycle 切到
  `dispatchable/epoch=2`，把 unresolved legacy publication 连 attempt/error 状态迁入 canonical delivery，删除旧
  `sqliteTaskLifecycleEventPublisher`、duplicate task WS publisher 与 terminal-hook active path；`6fac0b5bc97f57d0905b7b81c893d464c0bb6ce4`
  再以 migration `0220` 修复 rolling-upgrade FK rename 并保留 delivery receipts。
- `5318db02d18ce321ed37317d1265020e1feab687` 通过 migration `0222` 原子切换 review/clarify/questions，接入
  collaboration-owned transaction participants、closed events、durable consumers、synchronous WS projector 与唯一 continuous
  `HumanGateContinuationWorker`；route/composition 的 request-owned wake 和 covered direct broadcaster 均已归零。
- hosted 回归修复链 `9382d225481f525b7ade2f5c7141523287060090` →
  `a7677cf428ca1fcf187329b12d431ea48f54e2df` → `f52d274aca6f80f47e7b3f9afec49dd8424c47c2` →
  `853985bbf9f84c1f9c9e9cd3ed284a2b1ecf7a18` → `1bf179b3fbeb055dce28cd27cf57260b10114e07`
  闭合了初始化环、legacy gate scan 边界、rolling upgrade、stale cutover、pending successor 保留，以及 dispatcher/continuation
  nudge 的单一 ownership。
- commit-before-wake fault 最终证明：seal transaction 已 durable，但早期 post-seal functional dispatch 尚未 durable。
  `890c3ad402c8b3cc5a9fdff38d77086532e1a6e7` 与 `fed0e04ce26416f22e3ab8512a47806581da4411`
  把 compiled barrier 固定在 seal `dbTxSync` 返回后的真实 commit edge；`275f661b73495971864bfd12d22707ab5466d3ef`
  新增幂等 `finishCommittedClarifyAutoDispatch`，由 fresh request、receipt replay 与 claimed pre-drive 共用。actor user/role、答案归属与
  stop directive 在 seal transaction 内持久化；pre-drive 必须校验 exact intent/operation/manifest，convergence 成功才 drive，失败则把
  exact intent 保持为可周期重试的 pending，不会重复 mint rerun/intent，也不会返回伪造的 empty dispatch。
- `75cfadfa85dd3cdd1de269b7dedf700e27c02f8b` 把 exact claimed-intent retry writer 归入 worker-epoch authority；
  `acb518f81337b19633b39081265ad75259baea51` 随后关闭 RFC-128 commit-edge fixture 与 RFC-123 transaction source lock。
- `8f95c423fb594105cc136324e3b2f20397a465ed` 为 continuous dispatcher 增加与 transaction 完全同形的只读 due preflight：
  空队列不再每秒进入 `BEGIN IMMEDIATE`，有 candidate 时仍在 transaction 内重查并以 lease CAS claim；after-commit nudge 与
  一秒 reconcile 继续覆盖 read-false 后的新 event。最终 canonical payload / initial pin / forward repin 为
  `f94290d715365ee6c46e927c211a00326834157b` → `d2a4cc742c6dbb318b237ede15155b354cd79584` →
  `67a97480c5944c723d3ee08490631e4db768a5c6`，source digest 为
  `sha256:3714450fee40135133fb94fb846d6f4f32369d00625d8f7249e6049a80c73805`。
- exact SHA `67a97480c5944c723d3ee08490631e4db768a5c6` 的 Main CI run `33268925250` terminal success：static、build、
  frontend、全部 backend shard、三平台全部 Playwright shard与 `CI required` 全绿；RFC-294 restart / SIGKILL case 继续在三平台
  通过。该 SHA 上 8 个定时 workflow 也全部终态 success：e2e-full `33268950624`（含 RFC-319 覆盖账本汇总）、e2e-webkit
  `33268950212`、evidence `33268949064`、git-protocols `33268950157`、integration-opencode `33268949548`、maintenance-soak
  `33268952181`（100-client/full/180s，同 SHA attempt 2）、visual `33268950915`、windows-platform `33268951134`；maintenance
  通过期间未修改阈值或 RFC-341 源码。

RFC-294 只据此关闭 W3。W4 及后续 wave 仍须独立 successor、重新调研与明确批准。
