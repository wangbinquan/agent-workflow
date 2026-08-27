# RFC-333 技术设计：人工门原子停驻与持久续跑

> 状态：Approved / Publishing（2026-08-28；D1～D12 已获用户批准，T2～T11 已完成，当前执行 T12 hosted 收口）
>
> 本设计只闭合 RFC-294 P0-C。它以 RFC-326 已落的 review transaction 为种子，以 RFC-328
> `task_execution_intents` / ownership fence 为唯一 durable execution authority，以 RFC-332
> `TaskDriveCoordinator` 为唯一 drive 入口。D1～D12 与 T2～T12 已获生产实现授权；任何超出 P0-C、收缩正常能力或
> 新增安全/权限策略的变化仍不在授权内。

## 1. 设计不变量

### I1：领域决定与可续跑性不可分割

一个人工决定要么完全没有提交，要么同时满足：

```text
domain decision committed
∧ exact node projection committed
∧ task lifecycle revision advanced
∧ one canonical gate-continuation intent exists
∧ committed event exists
```

不能再出现 `answer=true ∧ continuation=false`。即时 drive 是否已经开始不是决定事务的一部分；pending intent 已经足以证明
系统最终可以继续。

### I2：可见 gate 与 task park 不可分割

一个 review/clarify gate 要么不可见且 task 未因它停驻，要么 gate manifest、node projection 与 task park 一起可见。
文件准备态不是 gate；只有 `TaskParkTx` 消费后的 operation 才能被 query 投影。

### I3：只有 task-execution 能改变 task/node execution authority

collaboration 决定领域顺序，但只能调用 task-execution 提供的 in-transaction participant。它不能 import `tasks`、
`node_runs`、`task_execution_intents` repository 或 `TaskDriveCoordinator` concrete implementation。

### I4：只有 collaboration 能解释人工门领域状态

task-execution 只接收 opaque `PreparedHumanGateRef` 与 purpose-specific participant。它不能理解 review selection、
clarify directive、question asker/rerun 或 doc archive 结构。

### I5：DB transaction 内无外部 I/O

事务回调只允许同步 durable DB mutation、CAS、event enqueue 与纯计算。FS/worktree/runtime/WS 都在事务外；需要最终完成的
外部效果必须先有 durable operation/artifact state。

### I6：一个 continuation authority、一个 drive authority

续跑只写 RFC-328 canonical intent；drive 只由 RFC-332 coordinator claim。operation journal 不是 execution queue，
artifact recovery 也不得直接启动任务。

## 2. bounded-context 与依赖边界

### 2.1 目标模块

```text
adapters/inbound/http + mcp
          │
          ▼
modules/collaboration/public/{commands,queries,types}
          │
          ├── domain/
          │    ├── humanGateOperation.ts
          │    ├── canonicalGateRequest.ts
          │    └── gateReceipt.ts
          ├── application/
          │    ├── prepareHumanGate.ts
          │    ├── commitHumanGateOpen.ts
          │    ├── decideHumanGate.ts
          │    ├── recoverHumanGateOperations.ts
          │    └── ports/
          └── infrastructure/
               ├── sqliteHumanGateOperationStore.ts
               └── fsHumanGateArtifactStore.ts
                         │
                         │ required in-tx participant
                         ▼
modules/task-execution/public/participants.ts
          │
          ├── TaskParkParticipantInTx
          └── TaskDecisionParticipantInTx
                         │
                         ▼
 task lifecycle writer + node projection + submitTaskContinuationTx
                         │
                         ▼ after commit
                 TaskDriveCoordinator
```

源码依赖使用 consumer-owned required port + composition adapter：

- collaboration application 定义它所需的 `TaskDecisionParticipantInTx` 形状，composition 绑定 task-execution offered participant；
- task-execution park orchestration 定义它所需的 `HumanGateOpenParticipantInTx`，composition 绑定 collaboration offered participant；
- 两边 public `types.ts` 只放 opaque id、receipt/view 与中性 revision 值，不导出 repository row 或 Drizzle table；
- bootstrap 只装配，不判断 gate kind、directive、task status 或 rollback 策略。

这两个运行方向并不形成源码循环；canonical architecture manifest 必须把具体 adapter 登记为 cross-context adapter，
并把双方 deep import 固定为 0。

### 2.2 owner 表

| 能力                                    | 唯一 owner                   | consumer                              | 禁止                             |
| --------------------------------------- | ---------------------------- | ------------------------------------- | -------------------------------- |
| gate operation/idempotency/receipt      | collaboration                | route/MCP、recovery                   | task route 自建 idempotency      |
| review/clarify/question domain mutation | collaboration                | public commands                       | task-execution 解释 payload      |
| task/node lifecycle CAS                 | task-execution               | collaboration participant、TaskEngine | collaboration 直接写表           |
| continuation intent                     | task-execution               | coordinator/recovery                  | 新 queue 或 route resume         |
| review doc artifact journal             | collaboration infrastructure | open prepare/recovery                 | DB tx 内文件操作                 |
| workspace rollback effect/receipt       | task-execution effect ledger | coordinator pre-drive phase           | collaboration 自建 effect queue  |
| actor-filtered gate view                | collaboration query          | REST/MCP/UI                           | command 返回内部 continuation id |
| WS projection                           | collaboration event adapter  | UI                                    | commit 前广播                    |

## 3. durable model

### 3.1 `collaboration_gate_operations`

新增一张窄表；最终 migration 编号在开工时按主干 migration head 分配，不在 RFC 中硬编码。

| 字段                                              | 语义                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`                                              | ULID，operation identity                                                            |
| `task_id`                                         | 所属 task                                                                           |
| `gate_kind`                                       | `review` / `clarify` / `questions`                                                  |
| `operation_kind`                                  | `open` / `decide` / `manual-question-open`                                          |
| `gate_ref`                                        | 稳定领域 identity；open 准备期可为 source-derived ref                               |
| `idempotency_key`                                 | caller key 或兼容派生 key                                                           |
| `request_hash`                                    | canonical payload hash，不含传输偶然字段                                            |
| `actor_user_id`                                   | 人工决定 actor；system/engine open 为 null                                          |
| `expected_task_revision`                          | Task lifecycle CAS 输入                                                             |
| `expected_gate_revision`                          | gate/domain CAS 输入；open 可为 0                                                   |
| `result_gate_revision`                            | commit 后的单调 gate revision；未提交为 null                                        |
| `state`                                           | `preparing` / `prepared` / `committed` / `cleanup_pending` / `completed` / `failed` |
| `claim_epoch`                                     | recovery claim fencing；每次重新 claim 单调增加                                     |
| `claim_expires_at`                                | maintenance 接管期限                                                                |
| `manifest_json`                                   | versioned purpose-specific manifest                                                 |
| `receipt_json`                                    | committed command receipt；重放返回同一内容                                         |
| `failure_json`                                    | 可恢复/终态准备失败摘要，不进入 gate view                                           |
| `created_at/updated_at/committed_at/completed_at` | 生命周期时间                                                                        |

约束：

1. `(task_id, gate_kind, operation_kind, idempotency_key)` 唯一；
2. 相同 key 必须匹配 `request_hash + actor_user_id`；
3. `committed` 以后 `receipt_json + result_gate_revision` 非空且不可改；
4. `prepared` 必须有完整 manifest；
5. operation 不存 continuation payload，不承担 task drive；
6. `(gate_kind, gate_ref, result_gate_revision)` 对非空值唯一；open 从 0→1，后续成功命令必须
   `result_gate_revision = expected_gate_revision + 1`；
7. active operation uniqueness 只约束同一个 exact gate/ref 的同一种命令，不阻止合法后续 round。

`manifest_json` 采用 discriminated union；review/clarify/questions 各有明确 schema 与 version。不得接受任意 callback、SQL
或无关领域 effect kind；这是模块职责边界，不是通用 workflow engine。

### 3.2 `collaboration_gate_artifacts`

仅 review doc archive 使用。worktree rollback 的 validated plan 直接进入 operation manifest，并在 final transaction 中变成
RFC-328 `task_execution_effects(kind='workspace-rollback')`；不为它再建 artifact 或 effect queue：

| 字段                          | 语义                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `operation_id + artifact_key` | 复合主键；如 `doc:0003`                                              |
| `artifact_kind`               | 当前闭合值只有 `review-doc`                                          |
| `staged_path`                 | operation 私有 staging 路径                                          |
| `final_path`                  | review doc 的 canonical path                                         |
| `sha256/byte_size`            | 内容完整性与 replay oracle                                           |
| `state`                       | `declared` / `staged` / `consumed` / `finalized` / `cleanup_pending` |
| `receipt_json`                | prepare/finalize 结果                                                |
| `updated_at`                  | recovery 排序                                                        |

多文档 review 的 manifest 固定 item order、source port、item path/index、selection inheritance、round generation、digest。
`TaskParkTx` 只在全部 declared artifact 都是 `staged` 且 digest 匹配时消费整轮；不能逐个让 doc row 可见。

### 3.3 不新增的状态

- 不新增第二 continuation 表；
- 不新增第二 task owner/lease；
- 不新增 generic node revision；
- 不新增 native timer；
- 不把 WS delivery 当 operation state；
- 不复制 review/clarify/question 的现有领域表为 shadow truth。

operation 表只保存 command/application recovery 状态；最终业务 query 继续从正式领域事实投影。

## 4. public 与 participant 合同

以下为 TypeScript 形状示意，最终命名可以随现有 style 微调，但权责与字段上限不可扩大。

```ts
type HumanGateKind = 'review' | 'clarify' | 'questions'

type PreparedHumanGateRef = Readonly<{
  operationId: string
  taskId: string
  gateKind: HumanGateKind
  expectedTaskRevision: number
  manifestDigest: string
}>

type GateDecisionCommand = Readonly<{
  taskId: string
  gate: HumanGateIdentity
  actor: TrustedActorRef
  idempotencyKey: string
  expectedTaskRevision: number
  expectedGateRevision: number
  payload: ReviewDecision | ClarifyDecision | QuestionDispatchDecision
}>

type GateNodeProjectionFence = Readonly<{
  digest: string // canonical exact node-run ids + statuses + source identities
  memberCount: number
}>

type GateDecisionReceipt = Readonly<{
  operationId: string
  gate: HumanGateIdentity
  gateRevision: number
  taskRevision: number
  acceptedAt: number
  replayed: boolean
}>
```

`GateDecisionReceipt` 不含 `continuationIntentId`、worker id、owner token、runtime handle、rollback internal error 或 `resume` 字段。
现有 REST response 若还需要 review/round/task view，facade 在 command 返回后调用 actor-filtered query 重新读取。

### 4.1 task-execution offered participant

```ts
interface TaskDecisionParticipantInTx {
  acceptGateDecisionTx(args: {
    taskId: string
    gate: HumanGateIdentity
    expectedTaskRevision: number
    expectedNodeProjection: GateNodeProjectionFence
    continuationLineage: GateContinuationLineage
    workspaceRollbackPlan?: PreparedWorkspaceRollbackRef
    operationId: string
    now: number
  }): {
    taskRevision: number
    continuationRef: TaskContinuationRef
  }
}
```

实现必须在同一个 transaction 内：

1. 校验 task lifecycle revision 与 allowed-from status；
2. 校验 exact gate-owned node projection；
3. 执行 gate release 所需 node/task transition；
4. 调用现有 `submitTaskContinuationTx`；若携带 rollback plan，则在同一 transaction 为该 intent 写入现有
   `task_execution_effects(kind='workspace-rollback')`，不另建 effect queue；
5. 让 task lifecycle writer 生成唯一 committed lifecycle event。

返回的是 opaque ref；collaboration 只能把它关联进 operation receipt，不能 query 或 mutate intent repository。

### 4.2 collaboration offered participant

```ts
interface HumanGateOpenParticipant {
  consumePreparedGateTx(args: {
    transactionScope: TransactionScope
    prepared: PreparedHumanGateRef
    taskRevision: number
    now: number
  }): {
    gate: HumanGateIdentity
    gateRevision: number
    nodeProjectionDigest: string
    committedEventRef: string
  }
  listPreparedManualQuestionParksTx(args: {
    transactionScope: TransactionScope
    taskId: string
  }): readonly string[]
  consumeManualQuestionParkTx(args: {
    transactionScope: TransactionScope
    operationId: string
    taskId: string
    now: number
  }): ManualQuestionParkReceipt
}
```

consumer-owned required port 只接收短生命周期 opaque `TransactionScope`；collaboration adapter 在 scope 内解析同一个 live
SQLite transaction，public 合同不接收或返回裸 `DbTx`，scope 也不能逃逸。TaskParkTx 先验证 ownership token/fence，再让
participant 消费 prepared operation；随后通过 task-execution 自有 lifecycle port 在同一 transaction 内提交 task park。任何
participant 失败都会回滚整笔 DB mutation，prepared operation 留给 retry/recovery。T7 已把 collaboration 的 ORM、node mint 与
lifecycle 适配实现下沉到 infrastructure，application 不再反向 import legacy service / `drizzle-orm`。

## 5. 打开人工门

### 5.1 review open

```text
TaskEngine / Review executor
  │
  ├─ collaboration.prepareReviewGate(command)
  │    ├─ claim/create open operation
  │    ├─ resolve current source snapshot
  │    ├─ derive all doc bodies + inherited selections
  │    ├─ write N staged artifacts, each digest-journaled
  │    └─ state=prepared; return PreparedHumanGateRef
  │
  └─ TaskParkTx(preparedRef, OwnershipToken)
       ├─ verify current task/owner/revision
       ├─ consumeReviewGateTx
       │    ├─ mint/reuse exact review node projection
       │    ├─ insert all doc_versions from one manifest
       │    └─ operation=committed + event
       ├─ task running → awaiting_review
       └─ commit
              │
              ├─ roll-forward staged files to canonical paths
              └─ publish after-commit WS invalidate
```

空列表 review 保持 RFC-202 的自动通过语义：prepare 发现 0 item 时不创建 visible gate，而是返回现有 engine 可理解的
auto-accepted outcome；不得先 park 再靠 repair 解锁。

re-entry 使用稳定 key：task + review node + source port + iteration + source snapshot digest。相同 manifest 重放同一个 operation；
source digest 改变则是新 operation/gate revision，不能覆盖已经 committed 的 round。

### 5.2 clarify open 与 eager questions snapshot

```text
clarify envelope parsed
  ├─ prepareClarifyGate
  │    └─ persist prepared manifest:
  │       self/cross identity, iteration, questions, truncation warnings,
  │       asking/intermediary/source refs, eager asker entries
  └─ TaskParkTx
       ├─ mint/reuse intermediary node projection
       ├─ insert clarify_round
       ├─ insert task_questions snapshot rows
       ├─ task running → awaiting_human
       ├─ operation=committed + event
       └─ commit → WS
```

`task_questions` 的 legacy read-time reconciliation 保留为旧数据兼容读路径：仅当历史 clarify round 没有 materialized snapshot
时补齐，且不能成为新 open 的正确性前提。implementation gate 记录新 operation 全量覆盖后，再由单独 cleanup task 删除 fallback；
本 RFC Done 前至少要有 guard 阻止新 gate 依赖 lazy reconciliation。

self re-emit 与 cross iteration 规则保持 current：稳定 manifest key 先命中同轮 operation，合法新 round 才计算下一 iteration。

### 5.3 manual question

手工问题不是新的 node gate。它继续是 task question board 上的 interrupt intent：

1. route/application 在一个事务中写 manual question 与 `manual-question-open` operation；
2. 若 task 已在可见人工门状态，question 立即附着到当前 board；
3. 若 task 正由一个 exact owner 运行，route 不改 owner、不直接 park、不直接 resume，只留下 durable park obligation；
4. 当前 TaskEngine 在下一个拥有 ownership token 的 settle point 通过 TaskParkTx 消费 obligation；
5. failed/interrupted/pending 等 current 允许状态继续按现有产品语义投影，恢复时不得丢问题。

这条特例保持当前“运行中也能提问”的能力，又避免 HTTP route 绕过 RFC-328 fencing 强改 active task。

## 6. 提交人工决定

### 6.1 统一 command pipeline

```text
HTTP/MCP facade
  ├─ parse existing wire payload
  ├─ resolve actor + expected revisions
  ├─ choose explicit/derived idempotency key
  └─ collaboration.decideGate(command)
       ├─ canonicalize payload → requestHash
       ├─ replay existing committed receipt, or claim operation
       ├─ prepare validated idempotent external-effect plan if required
       └─ dbTxSync CollaborationDecisionTx
            ├─ re-check operation claim/hash/actor/revisions
            ├─ write review/clarify/questions domain decision
            ├─ call TaskDecisionParticipantInTx
            │    ├─ exact node transition/rerun
            │    ├─ task awaiting_* → pending
            │    └─ submitTaskContinuationTx(gate-continuation)
            │         + linked workspace-rollback effect when required
            ├─ operation=committed + receipt
            └─ domain/lifecycle committed events
                 │
                 ├─ coordinator.wake(opaque continuation ref)
                 │    └─ pre-drive: settle linked rollback effect + projection
                 ├─ roll-forward/cleanup prepared artifacts
                 └─ WS invalidate
```

所有分支在进入 transaction 之前完成 payload 解析、batch 全量校验与不会漂移的纯推导；依赖当前 DB 状态的判据在 transaction
内重查。`Promise.allSettled` 不得被用来吞掉某个 batch member 的失败；批量命令仍是全成或零写。

### 6.2 review decision

RFC-326 已把 review comments/selections/decision/node mutation 主体收进一个 `dbTxSync`，本 RFC 保留其顺序与 oracle，
只完成两个 residual：

1. 把 worktree rollback 从“决定事务之前的裸动作”改为可逆 plan prepare；final transaction 同时写入既有
   RFC-328 `workspace-rollback` effect，与新 continuation intent 绑定；
2. 在该 final transaction 中调用 task-execution participant，提交 task transition + canonical continuation；
   coordinator 在进入 engine 之前先结算 linked effect 与 `rolledBack` projection。

review decision 的 approve/reject/iterate、multi-doc subset、comment anchor、source-offset、history 与 distill enqueue 语义不变。
distill enqueue 按 RFC-326 已批准边界继续是 commit 后派生工作，不被强塞进决定事务。

prepare 阶段只执行 snapshot existence/check-only，并生成带 workspace revision/digest、target snapshots 与 resource keys 的
幂等 plan，不修改 canonical worktree。final transaction
把 plan ref、continuation 与 `workspace-rollback` effect 一起提交；提交后 coordinator 的 pre-drive phase 通过既有 effect
claim/fence 执行一次 rollback，写 effect receipt，并在进入 rerun engine 前更新 `rolledBack`/marker projection。rollback 失败继续
保持 RFC-326 的 best-effort 语义，但失败本身有 durable receipt；进程在任意边界退出都能重放，不能仅凭“文件看起来不同”猜测。

### 6.3 clarify decision

partial answer 继续保持 gate open，只更新 round/question projection，不创建 continuation。只有 current 语义中真正 release gate 的
full answer/directive 分支才进入 task participant 并追加 intent。`defer/stop` 等指令沿用现有 node/task结果；target participant
接收的是已经由 collaboration 解释好的闭合 transition variant，不重新解析 directive 文本。

### 6.4 question dispatch

question dispatch 的 stamping、answer snapshot、rerun mint/transition 与 task continuation 进入同一 final transaction。
定向 rerun、全部回答、asker grouping、question order 与 current validation 保持。任何一个 member stale/invalid 时零写；
成功时恰好一个 task-level gate continuation intent，不能按 asker 各写一个 task intent。

### 6.5 gate continuation 的 pre-drive effect phase

RFC-332 已把 repository preparation 收为 coordinator 的 phase 0；P0-C 以同一种分层增加一个更窄的 gate-continuation
pre-drive phase，但不新增 engine kind或第二 coordinator：

1. 只有 `kind='gate-continuation'` 且存在 linked open `workspace-rollback` effect 时进入；
2. coordinator 取得 RFC-328 exact owner/epoch 后，通过 purpose-specific workspace rollback port 执行；
3. effect attempt/receipt/fence 全部复用 RFC-328 表与 writer；成功或失败都形成 durable terminal receipt；
4. 在一个小 transaction 中把 receipt 投影到既有 upstream `rolledBack`/marker 行，然后才调用 TaskEngine；
5. crash 在 effect 已发生但 receipt 未写时，使用 plan digest、before/after facts 与 effect `outcome-unknown` 规则恢复；
6. 没有 linked effect 的 clarify/questions/approve continuation 零额外 I/O，直接进入现有 drive。

因此 final decision transaction 仍包含唯一 continuation intent，而 canonical worktree mutation 永远发生在它提交之后、
下游 rerun 之前。正常请求沿 coordinator 的同一 submission 先等待这段 pre-drive effect settle，再按现有后台语义启动 engine，
从而保持“响应前已尝试 rollback”；若进程在此退出，committed receipt 不回退，boot/ticker 从同一 intent/effect 接手。
operation recovery 不直接 drive；task-execution intent/effect recovery 是唯一执行入口。

## 7. revision、幂等与并发

### 7.1 canonical request hash

hash 输入：

```text
schemaVersion
+ taskId
+ gateKind + stable gate identity
+ actorUserId (or system identity)
+ expectedTaskRevision
+ expectedGateRevision
+ canonical business payload
```

HTTP header、JSON key order、UI 临时字段、trace id、worker id、时间戳与 derived display text 不进入 hash。

### 7.2 compatibility idempotency key

新客户端可显式提供 `Idempotency-Key`。为保持现有网页/MCP 不必同步升级，facade 缺省派生：

```text
compat:v1:<gate-kind>:<gate-id>:<actor>:<expected-gate-revision>:<payload-hash>
```

这不会把两个合法连续决定合并，因为 gate revision 会前进。相同 HTTP response 丢失后的重试命中 committed receipt；
同 key 不同 hash/actor 返回现有 conflict error family，零业务写。

### 7.3 revisions

- task：使用现有 `tasks.lifecycle_event_revision`，所有 status writer 继续经唯一 lifecycle CAS；
- gate：每个 committed operation 写唯一 `result_gate_revision`，gate view 取 latest committed revision；open=1，partial answer、
  comment/selection/decision 等成功命令依次前进。它映射现有 review iteration、clarify round status 与 question ledger，
  但不复制这些领域 payload；
- node：用 exact node run id + expected status/source identity 参与 task participant 校验，不新增泛化 node revision；
- operation：`claim_epoch` 只 fence recovery actor，不等价于业务 gate revision。

RFC-333 切换时仍可能有 legacy open gate。migration/recovery 在 task/gate lock 内为它创建一次 `legacy-seed` committed operation，
把当前 review iteration/round/question facts 映射成 revision 1；同一 gate 只能有一个 seed。新 command 不允许在“没有 revision 就
临时猜一个”的路径继续写。

新 view/客户端提交 `expectedTaskRevision + expectedGateRevision`。为保持现有网页/MCP wire 可渐进升级，字段在第一批是 optional：
缺失时 inbound facade 在创建 operation 的同一快照阶段读取当前 revisions、写进 operation/request hash，并在 final tx 再比较；
显式字段则保留真正的 stale-tab 409。所有官方客户端在 T10 切为显式提交后，再单独移除 compatibility fallback。

### 7.4 winner/loser

两个 actor 并发提交同一 gate：

1. 都可完成纯 validation；
2. 只有一个能以 expected gate/task revision commit；
3. winner 同时推进 domain + task + intent；
4. loser transaction 零写，返回 latest actor-filtered view/conflict；
5. loser 不做 rollback、wake 或 WS。

## 8. recovery 与 maintenance

### 8.1 operation recovery

复用全局 maintenance ticker 注册一个 collaboration phase，不创建 `setInterval`：

| state                             | recovery                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `preparing` claim expired         | 检查 artifact receipts；继续 prepare 或转 cleanup/failed                      |
| `prepared` 未消费                 | 若 source/task/revision 仍匹配则供 owner retry；否则 cleanup staged artifacts |
| `committed` artifact 未 finalized | roll-forward 到 canonical path，digest 对拍后 completed                       |
| `cleanup_pending`                 | 幂等删除未消费 staging，完成后 completed                                      |
| committed decision、wake 未发生   | 不由 operation 直接 drive；RFC-328 pending intent recovery 负责               |
| linked rollback effect 未终态     | coordinator pre-drive 复用 RFC-328 effect claim/fence/receipt 收敛            |

operation recovery 与 task drive recovery 是两条职责清晰的 worker：前者只收敛 collaboration artifacts/prepare plan，
后者只 claim canonical intent，并在进入 engine 前收敛该 intent 已绑定的 RFC-328 execution effect。

### 8.2 read availability during roll-forward

最终事务提交后 artifact 可能尚在 staged path。`doc_versions` manifest 保存 logical body path 与 digest，artifact reader 在
operation `committed` 未 finalized 时可以从 staged path 读同一 digest；roll-forward 完成后只读 canonical path。
因此 commit→rename crash 不会让已提交 review 暂时 404，也不需要把 rename 放进 transaction。

### 8.3 boot 顺序

1. migration/schema ready；
2. collaboration artifact recovery 注册；
3. RFC-328 ownership/intent recovery；
4. HTTP/MCP 接流量；
5. maintenance ticker 按既有 cadence 继续收敛。

启动不要求先同步扫完全部历史 operation；但同一个 gate command 在 recovery claim 未过期时只能 replay/wait，不能双重执行。

## 9. event 与 view

### 9.1 committed event

collaboration event 至少带：

```ts
type HumanGateCommittedEvent = {
  eventId: string
  operationId: string
  taskId: string
  gate: HumanGateIdentity
  gateRevision: number
  kind: 'opened' | 'decision-accepted' | 'questions-dispatched'
  committedAt: number
}
```

不携带 runtime/continuation internal id。task lifecycle event 继续由 task status writer 生成；同一 transaction 允许两个 context
各写自己的 committed event，但各自只有一个 owner，WS adapter 只消费 committed projection。

### 9.2 route/MCP facade

三条 route 的目标职责只有：

1. parse/validate existing wire；
2. resolve trusted actor 与 route-level dependency；
3. 调 collaboration public command/query；
4. map domain error 与既有 response；
5. 返回 actor-filtered result。

route 不再：

- 调 `resumeTask` / `resumeTaskWithAtomicSideEffects`；
- mint/transition node run；
- 操作 review rollback；
- 读取 continuation repository 或返回 worker failure；
- 自己决定重放/恢复。

RFC-329 的 named MCP tools 继续 dispatch exact route template，因此自动获得相同事务性。RFC-333 不新建一套 MCP-only command，
也不宣称清完 RFC-329 剩余的全域 catalog debt。

## 10. legacy cutover

### 10.1 双写禁止

允许先落 additive table、domain type 与 inactive adapter；每个具体 gate 的 production switch 必须是 single-consumer cut：

- review open 一次从逐 doc create 切到 prepared manifest + TaskParkTx；
- clarify open 一次从 node/round 分写切到 prepared manifest + TaskParkTx；
- review/clarify/questions decision 各自一次从 route resume 切到 final transaction participant；
- legacy route 不得在新 command 失败后 fallback 到旧 resume saga。

可以按 gate vertical slice 分批提交，但任何已切 slice 都必须独立满足原子性和恢复测试，不能发布“新领域写 + 旧 route resume”的半态。

### 10.2 compatibility fallback

只保留两类读兼容：

1. 历史 clarify round 没有 eager task-question snapshot 时，读时 reconciliation 补旧数据；
2. 历史已回答但没有 canonical intent 的 rows，由现有 boot repair 识别并迁入一次 canonical intent。

新 operation 不能依赖这两条 fallback。守卫以 operation `created_at/schemaVersion` 区分新旧，禁止用“查不到就猜”覆盖新数据错误。

### 10.3 UI 清理

当三条 decision route 全部切换且 crash matrix 证明 durable intent 后：

- 删除 UI 对 `resume` optional failure 的展示与类型；
- 把 RFC-202 的三条“必须显示 resume failure”source-lock 改为“route response 不含 internal resume、决定可经 query 重放”；
- 保留真实领域 validation、conflict、rollback preparation 与 command rejection 的错误反馈。

这不是吞错：决定未提交仍返回失败；决定已提交则由 durable intent 保证后续，不再把 worker wake 当作命令成败。

## 11. fault matrix

### 11.1 open

| 注入点                           | 必须收敛                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| operation insert 后              | 零 visible gate；expired claim 可重试/清理                 |
| artifact 1..N 写入中             | 零 visible review；staging 可清理                          |
| 全部 staged、`prepared` 前       | recovery 对拍 digest 后补 prepared 或清理                  |
| prepared 后、TaskParkTx 前       | 零 visible gate；exact owner 可重试消费                    |
| TaskParkTx 每个 mutation 后抛错  | DB 全回滚，operation 仍 prepared                           |
| commit 后、artifact rename 前    | 完整 gate/task park；reader 可读 staged；recovery finalize |
| rename 后、operation complete 前 | digest 对拍后幂等 complete                                 |
| commit 后、WS 前                 | query 可见完整状态；不要求 WS 才正确                       |

### 11.2 decide

| 注入点                             | 必须收敛                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| operation claim 后                 | gate 未变；相同命令可接管/replay                                         |
| rollback plan/before-image prepare | canonical worktree 未改；失败可清理，decision 未被误报 committed         |
| final tx 前                        | 零 domain/task/intent/effect 写                                          |
| final tx 每个 mutation 后抛错      | 全回滚；无 partial answer/decision/intent/effect                         |
| commit 后、wake 前                 | committed receipt + one pending intent + linked effect；restart 自动收敛 |
| rollback effect act→receipt        | outcome-unknown 按 plan digest/facts 恢复；不重复破坏 worktree           |
| effect receipt→projection/drive    | 先补 `rolledBack` projection，再进入 engine；不会跳过 rollback phase     |
| wake 后、HTTP response 前          | retry 返回同一 receipt，不追加 intent/effect/不重复 rerun                |
| WS 前/后重复 recovery              | query 一致，invalidate 幂等                                              |

### 11.3 race/stale

- user cancel 与 gate open；
- source refresh 与 review prepare；
- two decisions same gate；
- partial clarify answer 与 full release；
- manual question 与 task settle；
- daemon shutdown 与 continuation claim；
- task retry/cancel 与 stale operation recovery。

每一项都必须验证 winner 的完整效果、loser 零写、task owner/fence 不被绕过。

## 12. 测试与架构棘轮

### 12.1 characterization

实现前锁定 current 正常能力：

- review single/multi/empty、selection inheritance、comment/anchor、approve/reject/iterate、rollback；
- clarify self/cross/re-emit、partial/full/directive、truncation；
- questions snapshot/manual create/batch answer/targeted rerun；
- REST 与 RFC-329 named MCP tools；
- current UI 提交、刷新、重进与已 parked restart。

### 12.2 transaction/fault tests

提供 deterministic failpoint，不依赖随机 kill：每个 prepare/artifact/tx/wake/WS boundary 可单独触发。事务测试使用真实 SQLite
约束与 transaction adapter，不用一个“总是成功”的 fake 证明原子性。多文档 N 至少覆盖 0、1、3，故障覆盖每个 member gap。

### 12.3 process E2E

边界分两层验证：open/artifact/事务内 mutation 用真实 SQLite deterministic failpoint 精确覆盖每个 member gap；只有必须证明
“进程真的消失、HTTP 请求真的中断、下一 daemon 从 durable state 接手”的不可逆边界进入真实二进制 E2E。扩展
`e2e/rfc294-human-gate-restart.spec.ts`：

1. 保留 clarify/review 已停驻后的独立 SIGKILL/restart 与 same identity 断言；
2. clarify answer commit→wake 与 review decision commit→wake 各做一次外部 SIGKILL；
3. question dispatch final tx→wake 做一次外部 SIGKILL；
4. E2E 走真实 REST，RFC-329 exact route mapping guard 证明 named MCP 仍派发同一 command，没有 MCP-only writer；
5. restart 后断言原 gate/node identity 保持、pending canonical intent 被同一 coordinator 接管、task 最终完成。

barrier 只允许编入专用 E2E binary；production binary 对应常量为 `false`，不能出现环境变量即可暂停正式服务的测试后门。

### 12.4 architecture guards

- 三条 route 中 `resumeTask` / node mint/transition / rollback production call=0；
- collaboration 不 deep import task-execution infrastructure/DB tables，反向亦然；
- continuation table/predicate/claim/drive owner 仍唯一；
- operation/artifact state transitions 由一个 collaboration repository 实现；
- no native interval；recovery 只能注册 maintenance job；
- new operation 不走 lazy question reconciliation 或 legacy answered-row repair；
- route/MCP exact mapping 与 RFC-326/329 guards 保持；
- mutation fixtures 分别能抓住 route resume 回流、第二 intent queue、commit 前 WS、逐 doc visible insert 与 fallback 双写。

## 13. 迁移后架构图

```text
                         ┌──────────────────────────────┐
REST / MCP / Web UI ───► │ collaboration public facade  │
                         │ commands / queries / receipts│
                         └──────────────┬───────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                       │
             OPEN / PREPARE                           DECIDE / RELEASE
                    │                                       │
        ┌───────────▼───────────┐              ┌────────────▼────────────┐
        │ gate operation +      │              │ CollaborationDecisionTx │
        │ artifact journal      │              │ domain state + event    │
        └───────────┬───────────┘              └────────────┬────────────┘
                    │ PreparedHumanGateRef                   │ required participant
                    ▼                                        ▼
        ┌───────────────────────┐              ┌─────────────────────────┐
        │ TaskParkTx            │              │ task-execution in-tx    │
        │ gate + node + task    │              │ node/task CAS + intent  │
        └───────────┬───────────┘              └────────────┬────────────┘
                    │ commit                                 │ commit
                    ▼                                        ▼
             after-commit WS                    RFC-328 canonical intent
                                                            │
                                               ┌────────────▼────────────┐
                                               │ TaskDriveCoordinator     │
                                               │ claim / attach / drive   │
                                               └─────────────────────────┘
```

模块边界的核心不是目录名称，而是两条禁止跨越的线：collaboration 不拥有执行权威，task-execution 不解释人工决定。
两者只在同一个 DB transaction 内通过窄 participant 协作。

T7 生产兼容期只保留 `services/humanGateComposition.ts → modules/collaboration/composition` 一条具名、到期的 legacy
composition bridge，把原先 review/clarify/manual/start-task 的九条内部装配直连集中起来；R2 未新增，backend/repo value SCC
保持既有 `4/6`。该 bridge 在 legacy service dependency injection cutover 后删除，不进入终局模块图。

## 14. 与 RFC-294 的关系

RFC-333 Done 后只更新 RFC-294：

- P0-C：`partial → Done`；
- W2-C/W3 前置门：解除，但仍需新 RFC 与明确批准；
- W2-A/B、P0-D：事实不变；
- W2-C/D、W3/W4/W5：仍是未完成；
- RFC-326/328/329/332：作为已复用种子，不倒签额外 credit。

若任一 AC 未满足，P0-C 保持 partial，不允许用“主 happy path 已跑通”代替 crash/retry/route boundary 的退出门。

## 15. 2026-08-28 implementation 对账

- review、clarify、questions 分别由 purpose-specific domain command + required in-transaction participant 完成 final commit；
  `services/*DecisionComposition.ts` 只负责 concrete adapter 与 after-commit wake，不把领域顺序放回 route/bootstrap；
- `wakeHumanGateContinuation` 只提交已经原子 admitted 的 exact continuation ref，不再做第二次 lifecycle transition 或 mint 第二个
  intent；boot 的 `humanGateContinuationRecovery` 扫描 exact pending intent 并复用同一入口；
- orphan reaper 只保留“task pending、相关 run 全 pending、存在 exact pending gate-continuation intent”的恢复形状；任何 running
  row 仍按既有 orphan contract 中断，避免把真实存活执行误当 durable wake；
- shared response schema、REST/MCP facade 与 UI 都以 committed receipt 为成功边界；内部 wake failure 不再暴露给用户，真实领域
  rejection/conflict 继续原样返回；
- current architecture report 为 backend production files `920`、module files `396`、service files `379`、background
  entries `218`、ambient wiring `440`、known violations `31`、route→DB `15`、transport→DB `2`；本 RFC 没有新增第二
  continuation/owner/interval，也没有增加 known violation；
- 候选本地证据：backend 定向 `286/286`、frontend `100/100`、shared `2/2`、真实二进制 restart E2E `3/3`、
  architecture 非 provenance `23/23`。四份 content-addressed provenance 在 payload commit 后按该 commit 重钉，随后由 canonical
  replay 与 hosted CI 给最终证据。
