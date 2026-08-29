# RFC-341 技术设计 — 生命周期已提交事件与协作命令收口

- 状态：Draft（2026-08-29；生产实施待批准）
- current-source pin：`1947e1ad02d3eb3f8a0c062f2a2f42a1ce5f61ce`
- 对齐：RFC-294 W3；复用 RFC-328 durable ownership、RFC-333 human-gate transaction、RFC-310 Event Center
- 行为原则：保持现有功能、frame 与正常路径顺序；commit 后故障由 durable worker 补偿

## 1. 设计不变量

### I1 — 领域状态与 committed event 同生同灭

covered mutation 的领域写、operation receipt、event sequence 分配、event append 与 continuation intent（适用时）处于同一
`dbTxSync`。任何一项失败都回滚全部；after-commit 只能投影或触发已经存在的 durable work，不能补造事实。

### I2 — event schema 归 producer，delivery mechanism 归 platform

`task-execution` 与 `collaboration` 各自拥有 closed union、codec、aggregate identity、sequence 与 consumer manifest。
platform 可以保存 opaque encoded bytes 和 digest，但不能理解、修改或用任意 JSON 伪造领域 event。

### I3 — 一个 event 可以有不同可靠性 consumer

`deliveryClass` 不放进 event envelope；它属于 `(eventType, consumerId)` registry。同一个 decision event 可以同时驱动
critical Event Center publication、rebuildable continuation nudge 与 ephemeral WebSocket projection。这样修正 RFC-294 W3 草案中
把单一 `deliveryClass` 放进 envelope 的过时表述。

### I4 — 正常请求保持即时顺序，长工作永不阻塞响应

成功的 covered request 保持：

```text
transaction commit
  → decode committed receipt
  → synchronous lightweight WebSocket projection
  → nudge committed-event / continuation workers
  → command response
```

文件系统、task drive、长扫描、retry/backoff 与外部 effect 不得进入这条路径。若进程在 commit 后失效，durable worker 补投；
已提交 command 不因 after-commit 投影失败被伪装成回滚。

### I5 — sequence 是 aggregate 局部顺序

同一 aggregate 的 event sequence 单调且无重复。critical consumer 对同 aggregate FIFO；不同 aggregate 可并行。
不建立全平台总序，也不因一个 task 的 poison event 阻塞其他 task/review round。

### I6 — continuation intent 是续跑事实源

RFC-333 的 `gate-continuation` intent 继续是 exactly-once durable work identity。Collaboration event 只帮助观察与即时 nudge；
常驻 worker 必须能在没有任何 event nudge、没有原 HTTP request、daemon restart 后仅凭 pending intent 恢复。

### I7 — WebSocket 是 projection，不是完成凭证

WebSocket 投影使用 committed event 的已编码 payload，保持 current frame type/字段/顺序。没有连接、连接断开或重复 invalidate
都不改变 event/delivery 的 durable 结果；客户端重连仍以 DB query/refetch 恢复。

### I8 — current audience 行为只兼容，不扩写规则

projector 复用现有 channel 与可见结果，不新增或改变产品规则。本 RFC 的测试只锁功能输出；不引入新的策略体系。

## 2. current anatomy

### 2.1 task transition

```text
writeTaskStatusTx
  ├── update tasks.status + lifecycleEventRevision
  └── task_lifecycle_event_outbox INSERT       # 已同事务

commit
  ├── terminalTaskHook / notifyTaskTerminal
  ├── notifyChildBudgetTaskStatus
  ├── workspace prune callback
  └── emitTaskStatus / WebSocketTaskStatusPublisher

eventCenterWorker
  └── sqliteTaskLifecycleEventPublisher
        └── Event Center observe(platform.task.status-changed)
```

pilot 已证明 transaction/outbox；缺口是 post-commit fanout 仍由多套 owner 直接执行，且 outbox 在进入 Event Center 前的状态
无法在 UI 中统一观察。

### 2.2 collaboration decision

```text
route / MCP
  → typed review | clarify | question command
  → RFC-333 transaction
       ├── domain decision
       ├── task/node projection
       ├── operation receipt
       └── gate-continuation intent
  → request-owned wakeHumanGateContinuation
  → direct broadcaster(s)
  → response
```

新路径保留 typed command 与 RFC-333 transaction，只把 event append 放进 transaction，把 wake/broadcast 改为 receipt 驱动的
after-commit pump + worker。

## 3. 目标结构与依赖方向

```text
task-execution domain/application          collaboration domain/application
  TaskLifecycleCommittedV1                   CollaborationCommittedV1
  TaskLifecycleEventTx                       CollaborationEventTx
              │ encoded closed event                     │
              └──────────────────┬────────────────────────┘
                                 ▼
                    platform committed-event store
                  immutable events + delivery receipts
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
          Event Center      internal consumers   WS projectors
          publication       + reconcilers        (ephemeral)
                                 │
                                 ▼
                 HumanGateContinuationWorker
                     consumes durable intents
```

建议 owner 落位：

```text
packages/backend/src/
├── modules/task-execution/
│   ├── domain/taskLifecycleCommittedEvent.ts
│   ├── application/taskLifecycleEventParticipant.ts
│   ├── application/taskLifecycleConsumers.ts
│   ├── infrastructure/sqliteTaskLifecycleEventParticipant.ts
│   └── infrastructure/taskLifecycleWsProjector.ts
├── modules/collaboration/
│   ├── domain/collaborationCommittedEvent.ts
│   ├── application/collaborationEventParticipant.ts
│   ├── application/humanGateContinuationWorker.ts
│   ├── infrastructure/sqliteCollaborationEventParticipant.ts
│   └── infrastructure/collaborationWsProjector.ts
├── platform/events/committed/
│   ├── types.ts                  # 中性 envelope/store/delivery/cutover contracts
│   ├── sqliteStore.ts            # 不 import producer codec
│   ├── dispatcherWorker.ts
│   ├── afterCommitEventPump.ts
│   └── workerDefinitions.ts
└── bootstrap/
    └── ...                       # 只装配 definitions / projectors / consumers
```

路径可在实现前随 current tree 小幅调整，但 owner/import 方向与 public surface 不得改变。Context application 只能依赖
committed-event port；platform store 不得反向 import context internal。Bootstrap 是唯一 concrete composition root。

## 4. 通用 envelope 与存储合同

### 4.1 encoded envelope

```ts
type CommittedEventEnvelopeV1<TType extends string, TPayload> = Readonly<{
  eventId: string
  eventGroupId: string
  eventGroupOrdinal: number
  type: TType
  schemaVersion: 1
  producer: 'task-execution' | 'collaboration'
  family: 'task-lifecycle' | 'review' | 'clarify' | 'questions'
  aggregate: Readonly<{
    kind: 'task' | 'review-round' | 'clarify-round' | 'question-gate'
    id: string
    seq: number
  }>
  operationRef: string
  correlationRef: string | null
  causationRef: string | null
  occurredAt: string
  payload: TPayload
}>
```

约束：

1. `eventId`由producer registry的deterministic id函数生成；新type使用
   `producer/family/aggregate.kind/id/seq/type/operationRef` canonical bytes，既有task status pilot继续保留
   `task-lifecycle:${taskId}:${lifecycleRevision}`，确保pending/dead-letter迁移与Event Center dedupe不断裂；
2. `eventGroupId/eventGroupOrdinal` 把同一 transaction 中逻辑上不可拆的跨 context event 聚为一组并固定投影顺序；
   当前设计优先让每个 aggregate 只产一个 batch payload，避免组内半投递；
3. `occurredAt` 是 transaction 注入 clock 的时间，不在 retry 时重算；
4. 编码采用 producer codec registry 的 canonical JSON bytes，并持久化 `payloadDigest`；
5. event 不携带 handler、callback、DB handle、actor object 或任意未验证扩展字段；
6. `deliveryMode` / `producerEpoch` 是 store metadata，不进入领域 envelope；同一事实不因 rollout mode 改变 payload digest。
7. `operationRef`不可为空：已有command/intent/effect用其durable ref；纯engine lifecycle transition使用
   `task-lifecycle:${taskId}:${lifecycleRevision}`，maintenance repair使用其durable run/claim ref，不能在after-commit随机生成。

跨context command在transaction开始时从中性`CommittedEventGroupTx`取得基于`operationRef`的稳定`eventGroupId`；各typed
participant按该operation的closed projection plan领取固定ordinal。Task-only transition使用ordinal 0。Plan与T3 golden不一致时
bootstrap/source test失败；不得通过“谁先执行谁拿下一个号”的开放式callback顺序改变用户可见投影。

### 4.2 sequence allocation

新增中性 `committed_event_aggregate_heads`：

| 列 | 语义 |
| --- | --- |
| `producer/family/aggregate_kind/aggregate_id` | aggregate key |
| `last_seq` | 最后成功分配序号 |
| `updated_at` | 诊断时间 |

`allocateNextCommittedEventSeqTx` 在领域 transaction 内做 `last_seq + 1` 的原子 upsert/CAS。task lifecycle 切换时用
`tasks.lifecycle_event_revision` seed，确保新 seq 不倒退；collaboration 用已有 operation journal 顺序回填 head，不改现有 public receipt。
一个 transaction 对一个 aggregate 只 append 一个 closed batch event；跨 aggregate transaction（如 task + review）分别分配，
用同一 `eventGroupId/operationRef` 关联。

### 4.3 physical schema

#### `committed_events`

| 列 | 要求 |
| --- | --- |
| `id` | stable eventId primary key |
| `event_group_id/event_group_ordinal` | operation 内事件组与稳定投影顺序；组内ordinal唯一 |
| `producer/family/type/schema_version` | closed registry identity |
| `aggregate_kind/aggregate_id/aggregate_seq` | FIFO key；unique |
| `operation_ref/correlation_ref/causation_ref` | trace refs |
| `payload_json/payload_digest` | immutable canonical bytes + digest |
| `delivery_mode` | `shadow \| dispatchable`，append 后不可变 |
| `producer_epoch` | cutover epoch |
| `created_at` | commit fact time |

唯一约束至少包含 `(producer, family, aggregate_kind, aggregate_id, aggregate_seq)`、
`(event_group_id, event_group_ordinal)` 与 `id`。相同 id/digest insert 可按幂等
receipt 返回；相同 id 不同 digest 或相同 aggregate seq 不同 id 必须中止 transaction。

#### `committed_event_deliveries`

| 列 | 要求 |
| --- | --- |
| `event_id/consumer_id` | composite primary key |
| `class` | `critical \| rebuildable`；ephemeral 不建 durable row |
| `state` | `pending \| claimed \| accepted \| dead-letter` |
| `attempt_count/next_attempt_at` | bounded retry |
| `claimed_by/lease_epoch/claim_expires_at` | fenced claim |
| `last_error_code/last_error_summary/updated_at` | Event Center 诊断 |
| `accepted_at` | terminal success |

critical/rebuildable delivery row在event append transaction中按producer manifest一次生成；ephemeral只保留manifest映射、不建row。
不能由dispatcher运行时“发现” durable consumer后补写。
这样新增/删除 consumer 不会悄悄改变历史 event 的完成定义。

#### `committed_event_family_cutovers`

| 列 | 要求 |
| --- | --- |
| `producer/family` | primary key |
| `mode` | `legacy \| shadow \| dispatchable` |
| `epoch` | 每次切换递增 |
| `changed_at/change_ref` | rollout receipt |

writer 在领域 transaction 中读取该 family row：`legacy` 不写新 store；`shadow` 写 immutable shadow event 但继续 legacy
after-commit；`dispatchable` 写可投递 event 且只走新 pump。历史 shadow 永远不能由 dispatcher claim。

### 4.4 consumer manifest

```ts
type CommittedEventConsumerDefinition<E> = Readonly<{
  id: string
  eventTypes: readonly E['type'][]
  deliveryClass: 'critical' | 'rebuildable' | 'ephemeral'
  settle: 'delivery-accepted' | 'durable-effect-recorded' | 'projection-attempted'
  dedupeKey(event: E): string
  reconcile?: BackgroundJobDefinition
}>
```

Producer codec registry 与 consumer manifest 都必须 closed/self-check：event type 没有 consumer mapping、consumer 声明 unknown type、
critical/rebuildable 没有 dedupe/settle，或 ephemeral 声明 dead-letter 都在 bootstrap fail fast。

## 5. task lifecycle event family

### 5.1 closed union

```ts
type TaskLifecycleCommittedV1 =
  | CommittedEventEnvelopeV1<'task.created.v1', {
      taskId: string
      status: 'pending'
      createdAt: string
    }>
  | CommittedEventEnvelopeV1<'task.lifecycle-transitioned.v1', {
      taskId: string
      lifecycleRevision: number
      previousStatus: TaskStatus
      status: TaskStatus
      updatedAt: string
      errorSummary: string | null
      nodeChanges: readonly {
        nodeRunId: string
        status: NodeRunStatus
        cause: string | null
      }[]
      workspacePruneClaim: null | {
        claimedAt: string
        cause: string
      }
      sourceTerminationEffectRef: string | null
    }>
  | CommittedEventEnvelopeV1<'task.node-statuses-transitioned.v1', {
      taskId: string
      reason: TaskNodeTransitionReasonV1
      nodeChanges: readonly {
        nodeRunId: string
        status: NodeRunStatus
        cause: string | null
      }[]
      updatedAt: string
    }>
```

`nodeChanges` 只包含同一 transaction 实际改动的 node rows，不把全量 node snapshot 塞进 event；size gate 超限时
transaction participant 必须按稳定 page/event group 设计重新呈批，不能静默截断。Task status未变化但node row变化时使用
`task.node-statuses-transitioned.v1`；terminal sweep以`reason='terminal-reconcile'`走它，而不是修DB后手发WS。

task event family是task-list/task-status/task-done，以及W3-covered lifecycle/collaboration/terminal-repair node-status frame的唯一
producer。普通runtime output/log stream、workgroup message和本RFC未触碰的node mechanics frame不在这个唯一性声明内。
Collaboration transaction若同时改变task/node，必须在同一event group调用task participant追加task event；collaboration event
不重复携带或投影这些frame。

### 5.2 public Event Center compatibility

Task public projector 保留现有 source/event：

```text
platform.task-lifecycle v1
  └── platform.task.status-changed v1
```

`task.lifecycle-transitioned.v1` 投影到 current `TaskLifecycleObservation`，继续使用
`task:${taskId}:lifecycle:${lifecycleRevision}` dedupe key 与既有 routing facts/trigger params。内部 richer payload 不泄漏到现有
public event；新增 public schema 必须另行兼容评审。

### 5.3 producer writer

`writeTaskStatusTx` 继续是 task status 唯一 writer，但返回：

```ts
type TaskLifecycleCommitReceipt = Readonly<{
  task: TaskRow
  eventRefs: readonly CommittedEventRef[]
  changedNodeRuns: readonly NodeRunProjection[]
}>
```

所有 companion transaction 必须把实际 node change、workspace prune claim 与 source termination effect ref 交给同一
participant 编码；不得由 after-commit callback 再查一遍猜 payload。task create 与 terminal reconcile 也调用同一 public
participant，不复制 insert SQL。

### 5.4 consumers

| consumer id | class | accepted 条件 | reconcile |
| --- | --- | --- | --- |
| `event-center.task-lifecycle` | critical | EventRecord observation + delivery receipt 同事务 | Event Center existing retry |
| `task-terminal-gate-close` | critical | durable close/effect receipt recorded | terminal reconcile |
| `task-child-budget` | rebuildable | projection revision applied or already newer | boot + periodic rebuild |
| `task-execution-watch` | rebuildable | local waiters notified；无 waiter 也成功 | DB terminal poll |
| `task-workspace-prune-nudge` | rebuildable | durable prune claim 可见并已 nudge | existing claim scan |
| `task-ws-projector` | ephemeral | current frame projection attempted | reconnect/refetch；worker best effort补投 |

物理 workspace deletion 的成功不作为 event delivery accepted 条件；event 只保证 durable claim 已存在且执行器被唤醒。

## 6. collaboration event families

### 6.1 common vocabulary

```ts
type HumanGateKind = 'review' | 'clarify' | 'questions'

type GateRef = Readonly<{
  taskId: string
  nodeRunId: string
  gateKind: HumanGateKind
  gateId: string
  roundId: string | null
}>
```

### 6.2 closed union

```ts
type CollaborationCommittedV1 =
  | CommittedEventEnvelopeV1<'collaboration.human-gate-opened.v1', {
      gate: GateRef
      gateStatus: HumanGateStatusV1
    }>
  | CommittedEventEnvelopeV1<'collaboration.human-gate-decision-committed.v1', {
      gate: GateRef
      decision:
        | { gateKind: 'review'; kind: ReviewDecisionKind }
        | { gateKind: 'clarify'; kind: ClarifyDecisionKind }
        | { gateKind: 'questions'; kind: QuestionDecisionKind }
      gateStatus: HumanGateStatusV1
      continuationRef: string
      commentChanges: readonly ReviewCommentProjection[]
      selectionChanges: readonly ReviewSelectionProjection[]
    }>
  | CommittedEventEnvelopeV1<'collaboration.review-comments-changed.v1', {
      gate: GateRef
      changes: readonly ReviewCommentProjection[]
    }>
  | CommittedEventEnvelopeV1<'collaboration.review-selection-changed.v1', {
      gate: GateRef
      changes: readonly ReviewSelectionProjection[]
    }>
  | CommittedEventEnvelopeV1<'collaboration.question-dispatch-committed.v1', {
      gate: GateRef
      questionIds: readonly string[]
      dispatchMode: QuestionDispatchModeV1
    }>
```

约束：

- review/clarify/questions open 共用 gate-opened vocabulary，但 producer family 仍是具体 `review|clarify|questions`；
- decision event用typed producer codec校验`gate.gateKind === decision.gateKind`并复用三类current shared enum，不能由通用
  string绕过各gate state machine；`HumanGateStatusV1`、`QuestionDispatchModeV1`与`TaskNodeTransitionReasonV1`同样由T3锁定
  current closed值集，不在RFC中凭记忆新造枚举；
- decision transaction 内发生的 comments/selections 与 decision 同一个 batch payload，避免先发 comment 后 decision 崩溃；
- standalone comment/selection mutation 使用各自 event；
- clarify answer 与 question answer 属 decision event，不再另发无 durable identity 的“answered callback”；
- question dispatch 单独成 event，因为它可在没有人类 decision 的 background path 发生。
- task/node status变化一律由同组task event承载；collaboration event只拥有gate/comment/selection/question领域frame，防止两类
  projector重复发送task/node frame；
- `eventGroupOrdinal` 的具体顺序由T3 current golden锁定，不能凭设计偏好改变现有decision与status的先后。

### 6.3 command boundary

保留 purpose-specific public commands：

```text
OpenReviewGate / SubmitReviewDecision / ChangeReviewComments / ChangeReviewSelection
OpenClarifyGate / SubmitClarifyDecision
DispatchTaskQuestions / SubmitQuestionDecision
```

每个 command 返回现有 result 加内部 `CommittedCommandReceipt`；HTTP/MCP adapter 仍投影 current public response，不新增客户端必填字段。
内部 receipt 含 `operationRef/eventRefs/continuationRef?`，只给 after-commit pump 和 tests。Route 不再接 `wake` callback，
composition 不再注入 task driver。

### 6.4 consumers

| consumer id | class | accepted 条件 | reconcile |
| --- | --- | --- | --- |
| `event-center.collaboration` | critical | internal event 已形成 EventRecord/diagnostic record | Event Center retry |
| `collaboration-continuation-nudge` | rebuildable | exact pending intent 已确认并 nudge worker | continuous pending-intent scan |
| `review-distill-enqueue` | rebuildable | deduped durable distill job inserted/already exists | decision/event scan |
| `collaboration-ws-projector` | ephemeral | current review/clarify/question/node frames attempted | reconnect/refetch；worker best effort补投 |

continuation 的业务完成由 intent ledger/worker 记录，不把 task drive 完成绑成 event-delivery FIFO 的前序；否则一个长任务会阻塞
同 gate aggregate 的后续观察事件。

## 7. AfterCommitEventPump

### 7.1 public contract

```ts
interface AfterCommitEventPump {
  publishNow(receipt: CommittedCommandReceipt, legacyProjection?: LegacyProjectionReceipt): void
  nudge(eventRefs: readonly CommittedEventRef[]): void
}
```

`publishNow` 必须同步且有界：只从 receipt/event store 精确取本次 event，decode current codec，先按
`eventGroupOrdinal`、再按aggregate sequence调 ephemeral projector；
不扫表、不 sleep、不 retry、不 claim durable delivery、不 drive task。每个 projector 独立捕获错误并记录本地诊断，随后仍 nudge worker。

Rollout期pump读取family cutover mode：

- `shadow`：shadow event不decode/投影/claim；只调用bootstrap注入的typed legacy projection port，并在continuation worker已切换后
  用receipt中的`continuationRef`做in-process nudge；
- `dispatchable`：只decode canonical event并调用新projector；该family的legacy port必须已删除；
- final cleanup后`legacyProjection`参数与所有legacy port一起删除。

这让clarify/questions仍在shadow时也能由持续worker续跑，同时不把shadow event冒充已投递事实。

### 7.2 request composition

```text
const committed = command.execute(input)
afterCommitEventPump.publishNow(committed.internalReceipt, committed.rolloutLegacyProjection)
return projectCurrentHttpResponse(committed)
```

source guard 禁止 covered route/composition：

- import broadcaster；
- import `wakeHumanGateContinuation`；
- import continuation worker internal；
- 在 response 前 wait delivery accepted 或 task drive。

Shadow兼容只能藏在bootstrap注入的purpose-specific `LegacyProjectionPort`，route/composition本身不能import broadcaster；每个family
翻dispatchable时同批删除对应port。该port只保留current frame行为，不能claim continuation或写新的领域事实。

### 7.3 duplicate/order behavior

同一 process pump 对 receipt 有 bounded in-memory dedupe，避免 composition 重入；durable worker仍可再次投影。Projector 按
`aggregate.seq` 丢弃低于本进程已见 high-water 的旧 frame，并允许同 seq相同 digest no-op；跨context同组则按
`eventGroupOrdinal`保持current golden顺序。客户端只依赖当前invalidation/refetch语义，不把frame次数当业务计数。

## 8. workers 与 continuation

### 8.1 CommittedEventDispatcherWorker

一个 managed worker 定义负责：

1. claim due critical/rebuildable delivery；
2. decode producer codec；
3. 检查同 aggregate 前序 delivery accepted；
4. 调对应 consumer；
5. 在 consumer durable effect 与 accepted receipt 同事务时结算；
6. retry/backoff 或 dead-letter；
7. 对 newly dispatchable event best-effort 调 ephemeral projector，补 commit/pump crash 窗口。

claim 条件包含 `delivery_mode='dispatchable'`、current producer epoch、state/lease epoch。worker shutdown 先停 claim，再等待
当前 bounded delivery 结算或 lease handoff；health 返回 pending/claimed/dead-letter oldest age 与 last error。

### 8.2 HumanGateContinuationWorker

worker 不以 HTTP request 生命周期为 owner：

```text
start
  → immediate scan pending gate-continuation intents
  → wait on nudge or reconcile deadline
  → claim exact intent with existing owner/fence
  → invoke injected TaskDriveCoordinator
  → settle / legal handoff / retry
  → repeat
```

要求：

- nudge 只缩短等待，不承载唯一 work identity；丢 nudge 仍会扫描；
- 同一 intent 只有 durable claim owner；daemon restart/lease expiry 可 handoff；
- active task owner 存在时沿用 RFC-333/RFC-328 的 legal deferred handoff，不在内存 Promise 上无限等待；
- boot `humanGateRecovery` catalog entry 被持续 worker 的 initial scan 替代，不能两套 owner 同时 claim；
- tests 通过显式 worker harness 驱动，不复活 direct helper 作为 production path。

### 8.3 managed definition 边界

两 worker 都实现现有 `ManagedWorkerDefinition`；reconcile 提供 `BackgroundJobDefinition.run`。RFC-341 只增加 W3-owned definition
composition 与最窄 runner 适配，不迁移其他 legacy timers；W9 以后可把同一 definitions 纳入全局 registry而无需改 worker body。

## 9. WebSocket projection compatibility

### 9.1 task frames

task event projector是W3-covered task/node frame唯一owner。`task.lifecycle-transitioned.v1` 依次投影：

1. task-list invalidation；
2. task `status` frame；
3. terminal `done` frame（适用时）；
4. payload 中 nodeChanges 的 current node-status frames。

顺序、type 与 current required fields 由 golden fixture 锁定。`task.node-statuses-transitioned.v1` 只投影实际changed node rows；
若同event group还有collaboration event，则跨projector先后使用`eventGroupOrdinal`并以T3 golden为准。

### 9.2 collaboration frames

| committed event | current projection |
| --- | --- |
| human-gate-opened(review) | `review.created` |
| review-comments-changed | current comment add/update/delete frame |
| review-selection-changed | current selection frame |
| human-gate-decision-committed(review) | comments/selections（若有）→ decision |
| human-gate-decision-committed(clarify) | current `clarify.answered` / defer |
| question-dispatch-committed | current question-domain dispatch/pending projection |
| human-gate-decision-committed(questions) | current answer/decision |

Projector 不在投影时重新构造领域决定；全部 frame data 来自 committed payload 或现有 read model exact lookup。
同一transaction产生的task/node frame由同组task event唯一投影，collaboration projector不得重复发送。

## 10. Event Center 扩展

### 10.1 backend read/control DTO

复用现有 `/api/events` route family，增加内部 delivery query/control：

```ts
type EventDeliveryStage = 'producer-publication' | 'consumer-delivery'

type CommittedEventDeliveryView = {
  eventId: string
  stage: EventDeliveryStage
  producer: string
  family: string
  eventType: string
  aggregateKind: string
  aggregateId: string
  aggregateSeq: number
  consumerId: string | null
  mode: 'shadow' | 'dispatchable'
  state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  attemptCount: number
  nextAttemptAt: string | null
  lastErrorSummary: string | null
  updatedAt: string
  canRetry: boolean
}
```

Retry command 接 `eventId + consumerId/stage + observed leaseEpoch/updatedAt`，只把 current dead-letter CAS 回 pending并递增
manual replay generation；不重写 event payload、seq 或 operation receipt。沿用 Event Center 现有 route admission与页面入口。

### 10.2 frontend

现有 Event Center 页面增加：

- `Publication / Consumers` stage filter；
- producer family、aggregate、seq、consumer、attempt、next retry；
- expandable last error；
- dead-letter 行的 Retry 按钮与成功/pending反馈；
- shadow badge，但无 Retry；
- task/review/clarify/question identity 的现有详情链接（能构造时）。

无需新顶级导航、独立 ops 页面或新的用户工作流。

## 11. shadow、cutover 与 migration

### 11.1 phase A — schema + characterization

1. 创建 aggregate heads/events/deliveries/cutovers，四个 family 初始化 `legacy, epoch=1`；
2. 建 codec/manifest/source-lock/fault tests；
3. production path仍完全 legacy，无新 event append。

### 11.2 phase B — shadow producer

逐 family 翻 `legacy → shadow`；writer 在同 transaction append shadow event，after-commit 经typed legacy projection port保持current path。Shadow comparator
按 operationRef 对拍领域 row、legacy frame fixture 与新 payload；dispatcher SQL 必须结构上排除 shadow。

task pilot 特例：既有 `task_lifecycle_event_outbox` 继续是 active public Event Center publisher；new task event是 shadow。

### 11.3 phase C — pre-cutover drain

task family 切换前：

- 等旧 outbox pending/claimed=0；
- 把 unresolved dead-letter 连同 attempts/error 迁成 canonical event + Event Center consumer delivery；
- 证明 completed row 全部已有 EventRecord 或明确历史 receipt；
- snapshot row count/digest，禁止静默丢弃。

task family切换还必须把当前collaboration legacy broadcaster中的task/node status部分拆出并同批删除；review/clarify/questions
自己的gate/comment/selection/question frame暂时继续legacy。否则task projector已active而旧route仍发同一task/node frame，会形成双owner。

collaboration family 没有旧 outbox，但必须证明 legacy callback没有 in-flight transaction，并在短 publication critical section切换。

### 11.4 phase D — atomic family cutover

在数据库 transaction 中翻 `shadow → dispatchable` 并递增 epoch。之后的新 command receipt 只走 AfterCommitEventPump；旧 direct
broadcast/wake 由 mode gate 不可达。同一 family 不允许 legacy与dispatchable双 active。

切换顺序：

1. task lifecycle；
2. review；
3. clarify；
4. questions。

每族通过 hosted fault/order evidence 后再切下一族。

### 11.5 phase E — legacy extinction

全部 family 稳定后：

- 删除 `task_lifecycle_event_outbox` publisher/table/schema owner；
- 删除 `emitTaskStatus`、`webSocketTaskStatusPublisher`、terminal hook 与 covered direct broadcasters；
- 删除 request/route/composition 的 `wakeHumanGateContinuation` production imports；
- 删除 boot-only `humanGateRecovery` owner；
- 删除 rollout legacy/shadow branches，只保留 current dispatchable epoch与历史 immutable receipts；
- 更新 canonical architecture manifests，不新增临时 exception。

### 11.6 rollback

在 legacy code 未删阶段：先停新 admission/worker claim，等待 current claimed bounded settle或lease交接；冻结 family epoch；证明
dispatchable pending 已由兼容 worker接管后，原子翻回 legacy并用新 epoch，绝不让两个 owner active。Legacy cleanup 完成后的故障只走
forward fix/consumer replay，不通过恢复旧 direct broadcaster绕开 event事实。

## 12. failure matrix

| 故障点 | 已提交事实 | 恢复 |
| --- | --- | --- |
| transaction 内 event insert失败 | 无 | 全事务回滚 |
| commit 后、pump 前 crash | event/intent 有 | dispatcher/continuation scan |
| WS projector 抛错 | event/intent 有 | worker best effort + client refetch |
| consumer 执行前 crash | pending/claimed | lease expiry re-claim |
| consumer effect已写、accepted前crash | effect dedupe有 | 同事务 settle或按 eventId no-op后accepted |
| 同 aggregate前序 poison | 后序 durable但不可claim | dead-letter可见/人工retry；其他 aggregate继续 |
| continuation nudge丢失 | intent pending | periodic continuous scan |
| workspace delete失败 | terminal+prune claim有 | claim reconcile重试，不回滚终态 |
| daemon shutdown during task drive | intent/owner fence有 | legal handoff/lease recovery |
| manual retry并发 | dead-letter receipt有 | observed epoch CAS只允许一个成功 |

## 13. test strategy

### 13.1 contract/source locks

- 两个 closed union/codec/consumer manifest 双向穷尽与 mutation；
- W3 writer/broadcaster/wake/current pilot source inventory；
- route/composition no broadcaster/no wake/no driver；
- platform store no producer-internal import；bootstrap-only concrete composition；
- worker definition readiness/health/stop exact contract。

### 13.2 transaction/fault

- event insert trigger abort →领域/receipt/intent零写；
- same id/same digest replay、same id/different digest冲突；
- claim crash、lease expiry、effect/settle crash、retry/dead-letter/manual retry；
- same aggregate FIFO/cross aggregate parallel/poison isolation；
- commit-pump crash、daemon restart、continuation missed nudge。

### 13.3 compatibility

- current task/review/clarify/questions response fixtures；
- current WS frame fixtures与顺序；
- review batch comment/selection/decision原子顺序；
- RFC-333 slow sibling/deferred question/restart/owner handoff；
- existing Event Center subscriptions仍收到 `platform.task.status-changed` v1；
- child budget/watch/prune/terminal/distill reconcile。

### 13.4 UI/hosted

- Event Center filter/error/dead-letter/retry交互与窄屏；
- compiled daemon crash/restart system mock；
- exact-SHA 主 CI、scheduled fault/recovery、WebSocket/browser journey；
- 只审功能、恢复、顺序与可观察行为，不执行安全类门检。

## 14. architecture exit

RFC-341 只有同时满足以下条件才可把 RFC-294 W3 标 Done：

1. covered transaction 外“补写事件”=0；
2. task lifecycle与collaboration covered write各只有一个 committed-event producer；
3. `registerTerminalTaskHook`、两套 task-status publisher、三类 request wake、covered direct broadcaster均归零；
4. critical/rebuildable delivery、continuation intent、dead-letter/retry与worker lifecycle可观察；
5. `commit < immediate projection/nudge < response` 正常路径与 crash recovery均有证据；
6. current REST/MCP/UI/WS功能不退化；
7. shadow/cutover/legacy extinction完成，旧 task outbox不再是第二 active system；
8. W3-owned workers符合 managed definitions，但不倒签 W9全局 registry；
9. exact-SHA hosted required jobs terminal success并回填 proposal/plan/STATE/RFC-294。
