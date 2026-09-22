# RFC-368 技术设计：Reaction 执行合同切换

**状态**：Draft（设计门 r1 findings 已逐条回写）
**读法**：先读 [proposal.md](./proposal.md)；上游规范是
[RFC-294 design §3.5](../RFC-294-backend-layered-target-architecture/design.md)，本文件写的是
**实际实施的子集**与逐条偏离。

---

## 1. RFC-294 目标架构落位（母 RFC §8 强制项）

| 项 | 落位 |
| --- | --- |
| bounded context | `digital-employee`（合同 owner）+ `task-execution`（provider） |
| DE 侧层 | `domain/`（请求工厂 / 反馈裁剪 / 两套重试判据，全是纯函数）、`composition/required-ports.ts`（合同）、`application/`（编排）、`infrastructure/`（持久化） |
| TE 侧层 | **`application/adapters/reaction-execution-adapter.ts`**（实现 DE 的 required port）+ `infrastructure/`（admission 日志持久化） |
| 跨 context 合同 | 只有 DE-owned required port；TE 适配器落在 `application/adapters/*-adapter.ts`，账本按 `required-implementation` 记（非债） |
| bootstrap | 三个根各装配一次，只换 binding |

**适配器路径不是随意选的**：账本生成器（`tests/architecture/rfc294Canonical.ts` 的
`observedContextEdges`）判 `required-implementation` 的条件之一是
`/^application\/adapters\/[^/]+-adapter$/`。落在别处，TE→DE 的类型引用会被记成
`temporary-internal-debt`，AC-6 达不成。

## 2. 与 RFC-294 §3.5 的偏离项（逐条呈用户确认）

### 2.1 加固类（用户 2026-08-26 明令不立项）

| # | §3.5 要求 | 本 RFC | 理由 |
| --- | --- | --- | --- |
| D1 | TE 经 IA current-authority participant 对拍 admission 的 subject/revision | **不做**；authority 按 DE 采样值冻结进 request，TE 不回查 | 事务内二次重验 |
| D2 | `starting/acting` 无 durable stop receipt 时新 `activateClaim` 必须 conflict 的争用矩阵终检 | **只保留 epoch CAS 本身**（功能上防重复派发），不做终检与变异用例 | 并发竞态终检 |
| D3 | wrong brand/hash/operation reuse、nested mutation、stale claim、非 internal stamp 等「变异必红」矩阵 | **不做**；只保留合同类型约束与正向用例 | 写点注册表守卫 |
| D4 | crash takeover 复用 P0-D expired-owner fence | **不做**跨 owner 接管；崩溃恢复用本 RFC 自己的派发租约（§4.1） | 同 D2 类 |

### 2.2 功能性偏离（设计门 r1 补入，非加固）

| # | §3.5 要求 | 本 RFC | 理由 |
| --- | --- | --- | --- |
| D5 | `requestHash` 排除 brand 与自身 | **做** | 重放要命中同一条 admission，这是功能性的 |
| D6 | `access` 携完整 `admission` receipt | **简化为 `{operation, executionRef}`**，由 TE 查自己的 journal 核对 | receipt 无法在事务外重建；让 TE 查自己的表比让 DE 存一份 receipt 副本更简单，且仍不回读 DE |
| D7 | 人审 snapshot 的 `waiting` 带 artifact、`approved` 带 approval、`failed` 带 safeCode+diagnostics | **纯 tag**（`failed` 带 diagnostics ref） | 现状投影只消费状态；带 payload 需要另立闸门产物合同 |
| D8 | 非 initial attempt **必须**携反馈 artifact，mismatch 在 effect 前拒绝 | **允许降级**：反馈写入失败时 `{kind:'none'}`，不阻塞重试 | 今天 `previousError` 也不是必需品；让反馈写失败卡住重试是功能倒退 |
| D9 | 请求材料拆成 implementation / executionContract / input / workspace / policy 五个冻结 ref | **合并为单个 `plan: FrozenReactionPlanV1`** | 现状 `planJson` 就是这一整块；拆分属 E9 之后的合同细化，本 RFC 只做 typed 化 |
| D10 | 启动 liveness gate（两个 port 各恰一个 adapter、方法全实现） | **不做**启动门，只有源码层计数（AC-2） | 属启动期自检，与本 RFC 功能面无关；留给 W9 |

**不再偏离的两项**（r1 之前曾偏离，现已按上游做）：
- admission receipt 的 `execution` 必填、在事务内预分配（用户 2026-09-22 裁决）。
- snapshot 的 `stopped` 态（用户裁决顺带修，见 G7）。

## 3. 合同（DE-owned required ports）

落在 `modules/digital-employee/composition/required-ports.ts`。

### 3.1 请求材料与工厂

```ts
export type ReactionRequestHash = string & { readonly __brand: 'reaction-request-hash-v1' }
export type ReactionOperationRef = string & { readonly __brand: 'reaction-operation-v1' }
export type ReactionClaimEpoch = number & { readonly __brand: 'reaction-claim-epoch-v1' }
export type ReactionRetryFeedbackRef = string & { readonly __brand: 'reaction-retry-feedback-v1' }
export type ReactionDiagnosticsRef = string & { readonly __brand: 'reaction-diagnostics-v1' }

export interface ReactionExecutionRequestV1 {
  readonly version: 1
  readonly operation: ReactionOperationRef          // 稳定键：由 (roundRef, attempt.ordinal) 决定
  readonly employeeCase: { readonly id: string; readonly revision: number }
  readonly reaction: { readonly roundRef: string }
  readonly authority: { readonly subject: string; readonly revision: number }
  readonly attempt: {
    readonly ordinal: number                        // 0-based；initial 必须 0
    readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
    readonly retryFeedback:
      | { readonly kind: 'none' }
      | { readonly kind: 'artifact'; readonly ref: ReactionRetryFeedbackRef }
  }
  readonly plan: FrozenReactionPlanV1               // ← round.planJson 的 typed 形态，见 §4.2 预算写回
}

export interface PreparedReactionExecutionV1 {
  readonly __brand: 'factory-built-deep-frozen-reaction-request-v1'
  readonly request: ReactionExecutionRequestV1      // deep-frozen
  readonly requestHash: ReactionRequestHash
}

export function prepareReactionExecution(input: …): PreparedReactionExecutionV1
```

`requestHash = sha256(canonicalJson(request))`，hash material 排除 brand 与 `requestHash` 自身（D5）。
工厂校验：`mode==='initial'` ⇒ `ordinal===0 && retryFeedback.kind==='none'`，违反即抛。

**关键（设计门 P1-4）**：`plan` 必须取自 **round 行上已写回的冻结 plan**。今天
`#retryOrFailExecution`（`runtimeService.ts:3200-3217`）按**实时剩余预算**重算
`roundBudgetMs` / `maxTotalTokens` 后塞进 outbox payload，而 `round.planJson` **不更新**——
于是「同 round 同 ordinal ⇒ 同 hash」不成立（重放时 `consumedTotalTokens` 已变）。
§4.2 规定：预算收敛在 `retryRound` 事务里**写回 round**，hash 只对写回后的值算。

### 3.2 tx-bound admission participant

```ts
export interface ReactionClaimFenceReceiptV1 {
  readonly __brand: 'te-journal-backed-reaction-claim-fence-v1'
  readonly roundRef: string
  readonly claimEpoch: ReactionClaimEpoch
  readonly fenceRevision: number
}

export interface ReactionExecutionAdmissionReceiptV1 {
  readonly __brand: 'te-journal-backed-reaction-admission-v1'
  readonly fence: ReactionClaimFenceReceiptV1
  readonly operation: ReactionOperationRef
  readonly requestHash: ReactionRequestHash
  readonly execution: string        // ← **必填**：事务内预分配的 executionRef
}

export interface ReactionExecutionAdmissionParticipantInTxV1 {
  readonly __brand: 'reaction-execution-admission-in-tx-v1'
  activateClaim(input: {
    readonly employeeCase: { readonly id: string }
    readonly reaction: { readonly roundRef: string }
    readonly expectedPreviousEpoch: ReactionClaimEpoch | null
    readonly nextEpoch: ReactionClaimEpoch
    readonly authority: { readonly subject: string; readonly revision: number }
  }): Promise<ReactionClaimFenceReceiptV1>
  /** 对 (operation, requestHash) **幂等**：已登记则原样返回既有 receipt（含同一个 execution）。 */
  admitLaunch(input: {
    readonly fence: ReactionClaimFenceReceiptV1
    readonly operation: ReactionOperationRef
    readonly requestHash: ReactionRequestHash
  }): Promise<ReactionExecutionAdmissionReceiptV1>
  closeClaim(input: {
    readonly reaction: { readonly roundRef: string }
    readonly expectedCurrentEpoch: ReactionClaimEpoch
    readonly reason: 'completed' | 'canceled' | 'superseded' | 'exhausted'
  }): Promise<void>
}
```

**键的语义（设计门 P1-3）**：`operation` 是**稳定键**（round + ordinal），`claim_epoch` 是
**每次派发递增**。两者不能都做唯一键，否则「同一 ordinal 派发失败后再派发」必撞。裁决：
- `operation_ref` 是主键（稳定）；
- `claim_epoch` / `fence_revision` 是**该行上被更新的列**，不参与唯一约束；
- `admitLaunch` 对同 `(operation, requestHash)` 幂等返回，同时把 fence 推进到当前 epoch。

装配沿用仓内 `InTx` 定式（`composeRuntimeSelectionParticipantInTx(transaction, …)`）：
DE 注入 `(tx: ProviderNeutralDatabase) => ReactionExecutionAdmissionParticipantInTxV1`，
在 `session.transaction` 内调用；参与者不持裸 DB handle。

### 3.3 执行 port 与两个读取 port

```ts
export interface ReactionExecutionAccessV1 {
  readonly operation: ReactionOperationRef
  readonly executionRef: string
}

export type ReactionExecutionSnapshotV1 =
  | { readonly kind: 'pending' }
  | { readonly kind: 'completed'; readonly output: FrozenReactionOutputV1
      readonly metering: ReactionMeteringV1 }
  | { readonly kind: 'failed'; readonly errorClass: WorkspaceFailureClass
      readonly errorCode: string; readonly diagnostics: ReactionDiagnosticsRef
      readonly metering: ReactionMeteringV1 }
  | { readonly kind: 'stopped'; readonly receipt: ReactionExecutionStopReceiptV1   // ← G7
      readonly metering: ReactionMeteringV1 }

export type ReactionHumanReviewSnapshotV1 =
  | { readonly kind: 'not-applicable' }     // 该动作没有闸门（inputs 无闸门键）
  | { readonly kind: 'unknown' }            // 执行行已不在 / inputs 不可解析 → 消费端回落 round 状态
  | { readonly kind: 'planning' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'approved' }
  | { readonly kind: 'failed'; readonly diagnostics: ReactionDiagnosticsRef }

export interface ReactionExecutionPortV1 {
  launch(input: PreparedReactionExecutionV1, admission: ReactionExecutionAdmissionReceiptV1)
    : Promise<{ readonly executionRef: string }>       // === admission.execution
  inspect(access: ReactionExecutionAccessV1): Promise<ReactionExecutionSnapshotV1>
  inspectHumanReview(access: ReactionExecutionAccessV1): Promise<ReactionHumanReviewSnapshotV1>
  cancel(access: ReactionExecutionAccessV1): Promise<ReactionExecutionStopReceiptV1>
}

/** DE 拥有、**TE 消费**：把反馈 ref 解回正文拼进提示词。方向与 required port 一致，不新增反向边。 */
export interface ReactionRetryFeedbackReaderV1 {
  read(ref: ReactionRetryFeedbackRef): Promise<string | null>
}
/** DE 拥有、DE 自己消费：把 diagnostics ref 解回正文落 `round.outputJson` / `blockReason`。 */
export interface ReactionDiagnosticsReaderV1 {
  read(ref: ReactionDiagnosticsRef): Promise<string | null>
}
```

**人审三态的来源与映射（设计门 P2-2）**。今天
`inspectDigitalEmployeeHumanReviewState`（`digitalEmployeeExecution.ts:247-289`）返回 `null`
有三种来源：①task 行不存在 ②inputs 解析失败 ③inputs 无 `DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY`。
**只有 ③ 才是「没有闸门」**，而消费端（`runtimeService.ts:1300-1307`）对 `null` 是**回落到
round 状态**。所以：③ ⇒ `not-applicable` ⇒ 投影成 `skipped`；①② ⇒ `unknown` ⇒ 投影端
**保留今天的 round-state 回落**（`completed→approved` / `failed|obsolete→failed` / 否则 `planning`）。
把这两种合并成一态会让「task 行被删」的闸门从「已批准」变成「跳过」——语义错。

## 4. 数据流

### 4.1 派发（替代 `execution-launch` outbox）

**选择判据**（设计门 P1-1 / P2-1 / P2-4）：

```sql
(state = 'planned'     AND next_attempt_at <= :now)
OR
(state = 'dispatching' AND dispatch_lease_expires_at <= :now)   -- 崩溃重放
```

`next_attempt_at` 是 `NOT NULL DEFAULT 0`（可空会让 `NULL <= now` 恒不成立，新建 round
永远选不中）。选中后**先查案例**：`case.state === 'terminal'` ⇒ 直接结算该 round，不建任务
（今天 `runOneOutbox:2522-2529` 有这道短路，`terminateCase` 并不清 round）。

```
DE: dispatchOneReaction()
  ├─ 按上面的判据选一个 round（并占派发租约：dispatch_claimed_by / dispatch_lease_expires_at）
  ├─ case terminal？ ⇒ settleRound + closeClaim(reason:'canceled')，结束
  ├─ prepared = prepareReactionExecution({round, attempt, retryFeedbackRef})   // 纯函数
  └─ session.transaction(tx => {
        admission = admissionFactory(tx)
        fence   = admission.activateClaim({… expectedPreviousEpoch: round.claim_epoch,
                                              nextEpoch: round.claim_epoch + 1 })
        receipt = admission.admitLaunch({fence, operation, requestHash})  // 预分配 execution
        tx: round.claim_epoch = nextEpoch
            round.operation_ref = operation
            round.execution_ref = receipt.execution        // ← 事务内就写下
            round.state = 'dispatching'
     })
  └─ port.launch(prepared, receipt)         // act，事务之外，用 receipt.execution 当 taskId
  └─ store.markRoundRunning(roundId)        // CAS 谓词改成 state='dispatching'
```

**为什么预分配解掉三条 P1**：
- executionRef 在事务内就定下并落到 round 与 admission 两侧 ⇒ 「任务已建、ref 未写回」这一格
  **不存在**（P1-2）；`launch` 用该 id 建任务，重复调用按 id 幂等。
- `inspect` 只要 `{operation, executionRef}`，两者 round 行上都有 ⇒ 调用点构造得出（P1-5）。
- 唯一键之争按 §3.2 的裁决解决（P1-3）。

**接进 worker 循环（设计门 P1-6，必须做，否则整条链不跑）**。`runOneOutbox` 今天被**两个**
循环调用、四处声明：
- `digital-employee/application/osWorker.ts:12`（接口）/ `:60`（调用），
  `DigitalEmployeeOsCycleResult` 还带计数字段；
- `development-automation/composition/activityOperations.ts:4`（接口）/ `:33`（调用），
  `DevelopmentActivityResult` 带 `activity` 判别式；
- `digital-employee/composition.ts:393-396` 与 `:1083-1086` 两处装配。

`dispatchOneReaction` 必须在这四处同样接上。**插入位置有陷阱**：
`activityOperations.ts:38` 最后一句是无条件 `return { activity:'execution', … }`，
追加在其后就是死代码——必须插在 `inspectOneExecution` **之前**。

### 4.2 结算、重试与终结

**两套计数器都要保留**（设计门 P1-7；今天它们是两套不同公式跑在两个计数器上）：

| 层 | 今天在哪 | 计数器 | 退避 | 终结 |
| --- | --- | --- | --- | --- |
| round 级（执行失败后重试） | `#retryOrFailExecution:3170-3260` | `nextOrdinal` | `2**(nextOrdinal-1)` | `nextOrdinal > retryAttemptCap(...)-1` ⇒ `settleRound(failed)`，`handoffOnExhausted` 决定案例是否 terminal |
| 派发级（launch 本身失败） | `runOneOutbox` 的 catch `:2646-2712` | `outbox.attemptCount` | `2**(attemptCount-1)` | `attemptCount >= max(1, retryAttemptCap(...))` ⇒ `settleRound(failed)` / `terminateCase` / `blockCase` 三分支 |

派发级的那套整体搬到 round 的 `dispatch_attempts` 上，**公式与三个终结分支逐字保留**。
用户可见字面值按 C2-2 固定为：`outputJson.kind = 'reaction-dispatch-failed'`、
`blockReason` 前缀 `reaction-dispatch: `。

**预算收敛写回（P1-4）**：`retryRound` 事务里把重算后的 `roundBudgetMs` / `maxTotalTokens`
**写回 `round.planJson`**，再清 `operation_ref` / `execution_ref` 并置 `state='planned'`、
`next_attempt_at = now + backoff`。下一次派发的 `operation` 因 ordinal 变化而变，hash 对写回后的
plan 算——重放稳定。

**`closeClaim` 的调用点（设计门 P3-2）**：`settleRound` 有四个入口
（`#settleCompletedRound`、`#retryOrFailExecution:3247`、`#failRoundForUserLimit:3266`、
派发级终结兜底），另有 round 被置 `obsolete`、以及 `terminateCase` 时 round 仍在跑。
**这六处全部要调 `closeClaim`**，否则 admission 行永久停在 `admitted`/`launched`。

**取消语义（G7，用户裁决顺带修）**：
- TE 的 `inspect` 对 `task.status === 'canceled'` 返回 `{kind:'stopped'}`（今天走
  `resultFailure('execution-canceled')` 被当 failed）；
- DE 收到 `stopped` ⇒ `settleRound(state:'failed', terminalKind:'execution-canceled')`
  **但不进重试判定**——不消耗预算；
- `terminateCase` 路径上，对仍在跑的 round 调 `port.cancel(access)` 再 detach。

## 5. Schema（expand-only）

SQLite 迁移 `0230`，PostgreSQL 迁移 `0006`。

```sql
-- TE 拥有：admission 日志。operation 是稳定主键，epoch/fence 是行上被更新的列（§3.2）。
CREATE TABLE reaction_execution_admissions (
  operation_ref      TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL,
  round_ref          TEXT NOT NULL,
  claim_epoch        INTEGER NOT NULL,
  fence_revision     INTEGER NOT NULL,
  request_hash       TEXT NOT NULL,
  authority_subject  TEXT NOT NULL,
  authority_revision INTEGER NOT NULL,
  execution_ref      TEXT NOT NULL,        -- ← 事务内预分配，必填
  state              TEXT NOT NULL,        -- admitted | launched | closed
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX reaction_execution_admissions_round ON reaction_execution_admissions (round_ref);

-- DE 拥有：round 上的 claim / 派发调度 / 引用列
ALTER TABLE employee_reaction_rounds ADD COLUMN claim_epoch                INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_reaction_rounds ADD COLUMN next_attempt_at            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_reaction_rounds ADD COLUMN dispatch_attempts          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_reaction_rounds ADD COLUMN dispatch_claimed_by        TEXT;
ALTER TABLE employee_reaction_rounds ADD COLUMN dispatch_lease_expires_at  INTEGER;
ALTER TABLE employee_reaction_rounds ADD COLUMN last_dispatch_error        TEXT;
ALTER TABLE employee_reaction_rounds ADD COLUMN operation_ref              TEXT;
ALTER TABLE employee_reaction_rounds ADD COLUMN retry_feedback_ref         TEXT;

-- DE 拥有：content-addressed 的反馈与诊断（同一张表，两种 kind）
CREATE TABLE employee_reaction_artifacts (
  digest     TEXT PRIMARY KEY,             -- sha256(裁剪后正文)
  kind       TEXT NOT NULL,                -- retry-feedback | diagnostics
  body       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

**`dispatching` 状态要同步的判据（设计门 P1-9，漏一处就出 bug）**：

| 位置 | 改法 |
| --- | --- |
| 部分唯一索引 `employee_reaction_rounds_one_active`（`db/schema.ts:7378`、`db/migrations/0192_…:532`、`db/postgresql-migrations/0000_rfc349_baseline.sql:3562`） | `WHERE state IN ('planned','dispatching','running','settling')`——否则「一案一活跃 round」对新状态失效 |
| `markRoundRunning` 的 CAS 谓词（`runtimeStore.ts:1401`） | `state='planned'` → `state='dispatching'` |
| `activeRound` 判定（`runtimeService.ts:1146` / `:1243`） | 数组加 `dispatching` |
| 派发终结兜底的 round 过滤 | 同上 |
| `ReactionRoundRecord.state` 联合（`domain/runtimeModel.ts:316`） | 加 `dispatching` |
| 前端文案表（`frontend/src/routes/employee-cases.$caseId.tsx:318` 附近）与 `roundVisualState`（`:388-391`） | 加 `dispatching`：文案「正在启动 / Starting」，视觉态归 `running`——否则落兜底文案「状态已更新」+ waiting 样式 |

**在途数据迁移（设计门 P2-3）**：对每条 `state IN ('pending','claimed')` 的 `execution-launch` 行：
- `payload.attempt.previousError` 非空 ⇒ 按 §6 裁剪后写入 `employee_reaction_artifacts`，
  digest 挂到 `round.retry_feedback_ref`（**不能丢**，否则这次重试的理由消失）；
- `next_attempt_at` ← 行上的 `next_attempt_at`；`dispatch_attempts` ← `attempt_count`；
  `last_dispatch_error` ← `last_error`；
- `mode` 不入库，派发时按 `attempt_ordinal % (policy.sameSceneAttempts + 1)` 重算
  （公式同 `runtimeService.ts:3218`）；
- 迁移后删除这些行。`completed`/`failed` 的历史 `execution-launch` 行**原样保留**
  （`claimOutbox` 不会选中它们）；`kind` 列两个引擎都**没有** CHECK 约束
  （SQLite `0192_…:460`、PG baseline `:1244` 都是裸 `TEXT NOT NULL`），所以无约束可改。

## 6. 反馈裁剪（proposal §4 C1 的实现）

纯函数 `digital-employee/domain/reactionArtifacts.ts`：

```ts
export function sanitizeReactionText(input: {
  readonly errorCode: string
  readonly errorDetail: string
  readonly workspaceRoot: string | null
}): { readonly body: string; readonly digest: string }
```

顺序：R2 路径改写 → R3 栈帧处理（**待用户定，见 plan.md §4**）→ R4 折叠重复行 →
拼 `errorCode: ` 前缀 → R5 截断 4000。同一函数同时服务 retry feedback 与 diagnostics。

## 7. 失败模式（设计门 P1-1 / P1-2 补全）

| 场景 | 行为 |
| --- | --- |
| admission 事务提交后、`port.launch` 前崩溃 | round 停在 `dispatching`；**派发租约到期后被重新选中**（§4.1 判据第二支），同 operation 重放，`admitLaunch` 幂等返回同一 receipt（含同一 execution），`launch` 按该 id 幂等建任务 |
| `launch` 内部任务已建、返回前崩溃 | executionRef 事务内已定，round 与 admission 都有；重放拿同一个 id，TE 按 id 发现任务已存在 ⇒ 直接返回，不建第二个 |
| `markRoundRunning` 前崩溃 | 同上；租约到期重放，`markRoundRunning` 的 CAS（`dispatching`）幂等 |
| `activateClaim` 的 epoch CAS 失败 | 抛 `ConflictError('employee-reaction-claim-stale')`，跳过本轮，下 tick 重来 |
| `launch` 抛错（如 `exact agent unavailable`） | 清 `operation_ref`/`execution_ref`，`dispatch_attempts += 1`，按派发级退避排下一次；达上限走 §4.2 的三个终结分支（**不无限重试**） |
| 案例在 round 退避期间被 terminate | 下次派发命中 case-terminal 短路，结算 round + `closeClaim('canceled')`，不建任务 |
| 反馈 artifact 写入失败 | 降级 `{kind:'none'}` 并记 `last_dispatch_error`，不阻塞重试（偏离 D8） |
| 同 digest 反馈重复写 | 主键冲突 `onConflictDoNothing`，不新增行 |
| 执行被取消 | `inspect` 返回 `stopped` ⇒ 结算成已取消、**不消耗重试预算**（G7） |

## 8. 测试策略

**纯函数优先**：`prepareReactionExecution`（工厂校验 / deep-frozen / hash 稳定性）、
`sanitizeReactionText`（R1–R5 + 反例）、**两套**重试判据
（`roundRetrySchedule` 与 `dispatchRetrySchedule`，各自与改造前逐值对拍——AC-8）。

**双引擎集成**：AC-3 同事务原子性（注错参与者）、AC-4 重放幂等、AC-5 崩溃两格
（`dispatching` 租约过期重选 + 任务已建重放）、AC-9 去重、AC-11 人审三来源映射、
AC-13 不卡死、AC-14 case-terminal 短路、AC-15 取消语义、AC-16 派发级终结。

**源码层**：AC-1（两个 adapter 目录无 plan/attempt 的 JSON 序列化 + 旧 participant 已删）、
AC-2（optional 计数 0）、AC-7（`runOneOutbox` 无该分支 + 两个循环都调 dispatch）。

**不新增**：D2/D3 的并发与变异守卫矩阵。

## 9. 本 RFC 承担的架构演进 / 留下的债

**承担**：销掉 DE↔TE 的 6 条双向类型边；消灭 optional 方法造成的引擎间行为差；
把 outbox 承担的四件事（租约 / 单行重试 / 终结兜底 / 驱动循环）显式重建在 round 上。

**留下**：43 条根 → `digital-employee/composition.ts` 与 4 条 route → composition 归 **E9-D**；
`digitalEmployeeBuiltinToolCatalog` → `services/digitalEmployeeAgentTemplates.ts` 的 4 条归
E9-D / W9；observer / delivery worker 的 lifecycle 归 **W9**；D7/D9/D10 三项合同细化留给后续。
