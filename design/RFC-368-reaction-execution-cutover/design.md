# RFC-368 技术设计：Reaction 执行合同切换

**状态**：Draft
**读法**：先读 [proposal.md](./proposal.md)；规范性合同的上游是
[RFC-294 design §3.5](../RFC-294-backend-layered-target-architecture/design.md)（`PreparedReactionExecutionV1`
一节），本文件写的是**本 RFC 实际实施的那个子集**与逐条偏离。

---

## 1. RFC-294 目标架构落位（母 RFC §8 强制项）

| 项 | 落位 |
| --- | --- |
| bounded context | `digital-employee`（合同 owner）+ `task-execution`（provider） |
| DE 侧层 | `domain/`（attempt / 反馈裁剪纯函数）、`composition/required-ports.ts`（合同）、`application/`（编排）、`infrastructure/`（持久化） |
| TE 侧层 | **`application/adapters/reaction-execution-adapter.ts`**（实现 DE 的 required port）+ `infrastructure/`（admission 日志持久化） |
| 跨 context 合同 | 只有 DE-owned required port；TE 侧适配器落在 `application/adapters/*-adapter.ts`，账本按 `required-implementation` 角色记（非债） |
| bootstrap | 三个根（`server.ts` / `cli/start.ts` / `cli/postgresqlDaemonApplication.ts`）各装配一次，只换 binding |

**为什么适配器必须落在 `application/adapters/*-adapter.ts`**：账本生成器
（`tests/architecture/rfc294Canonical.ts` 的 `observedContextEdges`）判 `required-implementation`
角色的条件之一是 `/^application\/adapters\/[^/]+-adapter$/`。落在别处，TE→DE 的类型引用会被
记成 `temporary-internal-debt`，AC-6 达不成。

## 2. 与 RFC-294 §3.5 的偏离项（逐条呈用户确认）

母 RFC 要求偏离必须列明。下列条目**本 RFC 不实施**，理由均为用户 2026-08-26 明令
「安全加固类工作一律不立项」：

| # | §3.5 原文要求 | 本 RFC | 理由 |
| --- | --- | --- | --- |
| D1 | 「TE 还须经 IA current-authority participant 对拍 admission 中的 subject/revision，不能把 DE 采样的 authority 当永久授权」 | **不做**。authority 按 DE 采样值原样冻结进 request，TE 不回查 | 事务内二次重验 |
| D2 | 「`starting/acting` 尚未取得 durable stop/takeover receipt 时，新的 `activateClaim` 必须 conflict」的并发终检与变异门 | **只保留 epoch CAS 本身**（功能上防重复派发），不做争用矩阵的终检与变异用例 | 并发竞态终检 |
| D3 | 「wrong brand/hash/operation reuse、nested mutation、stale claim/access、非 internal stamp、raw JSON/path … 变异必红」 | **不做**变异守卫矩阵；只保留合同本身的类型约束与正向用例 | 写点注册表守卫 |
| D4 | 「crash takeover 复用 P0-D expired-owner fence」 | **不做**跨 owner 的接管协议；崩溃后的恢复沿用现有 round 状态机 + admission 重放 | 与 D2 同类，且现有恢复路径已覆盖功能面 |
| D5 | `requestHash` 的 canonical hash material「明确排除 envelope brand 与自身」 | **做**（这条是功能性的：重放要能命中同一条 admission） | — |

D1–D4 的共同后果：**本 RFC 交付的是功能正确的执行合同，不是经过加固的执行合同**。
后续若要补上，须另立 RFC 并单独获批。

## 3. 合同（DE-owned required ports）

落在 `modules/digital-employee/composition/required-ports.ts`。

### 3.1 请求材料与工厂

```ts
export type ReactionRequestHash = string & { readonly __brand: 'reaction-request-hash-v1' }
export type ReactionOperationRef = string & { readonly __brand: 'reaction-operation-v1' }
export type ReactionClaimEpoch = number & { readonly __brand: 'reaction-claim-epoch-v1' }
export type ReactionRetryFeedbackRef = string & { readonly __brand: 'reaction-retry-feedback-v1' }

export interface ReactionExecutionRequestV1 {
  readonly version: 1
  readonly operation: ReactionOperationRef
  readonly employeeCase: { readonly id: string; readonly revision: number }
  readonly reaction: { readonly roundRef: string }
  readonly authority: { readonly subject: string; readonly revision: number }
  readonly attempt: {
    readonly ordinal: number                       // 0-based；initial 必须是 0
    readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
    readonly retryFeedback:
      | { readonly kind: 'none' }
      | { readonly kind: 'artifact'; readonly ref: ReactionRetryFeedbackRef }
  }
  readonly plan: FrozenReactionPlanV1              // 今天 planJson 的 typed 形态
}

export interface PreparedReactionExecutionV1 {
  readonly __brand: 'factory-built-deep-frozen-reaction-request-v1'
  readonly request: ReactionExecutionRequestV1     // deep-frozen
  readonly requestHash: ReactionRequestHash
}

/** 唯一铸造入口，DE domain 拥有。外部 caller 不能 object-literal / cast 出来。 */
export function prepareReactionExecution(input: …): PreparedReactionExecutionV1
```

`requestHash` = `sha256(canonicalJson(request))`，hash material **排除** brand 与 `requestHash`
自身（D5）。`attempt.mode === 'initial'` ⇒ `ordinal === 0 && retryFeedback.kind === 'none'`，
工厂内校验，违反即抛。

### 3.2 tx-bound admission participant

```ts
export interface ReactionExecutionAdmissionParticipantInTxV1 {
  readonly __brand: 'reaction-execution-admission-in-tx-v1'
  activateClaim(input: {
    readonly employeeCase: { readonly id: string }
    readonly reaction: { readonly roundRef: string }
    readonly expectedPreviousEpoch: ReactionClaimEpoch | null
    readonly nextEpoch: ReactionClaimEpoch
    readonly authority: { readonly subject: string; readonly revision: number }
  }): Promise<ReactionClaimFenceReceiptV1>
  admitLaunch(input: {
    readonly fence: ReactionClaimFenceReceiptV1
    readonly operation: ReactionOperationRef
    readonly requestHash: ReactionRequestHash
  }): Promise<ReactionExecutionAdmissionReceiptV1>
  closeClaim(input: {
    readonly employeeCase: { readonly id: string }
    readonly reaction: { readonly roundRef: string }
    readonly expectedCurrentEpoch: ReactionClaimEpoch
    readonly reason: 'completed' | 'canceled' | 'superseded'
  }): Promise<void>
}
```

装配形态沿用仓内既有 `InTx` 定式（`composeRuntimeSelectionParticipantInTx(transaction, …)`）：
DE 注入一个 `(tx: ProviderNeutralDatabase) => ReactionExecutionAdmissionParticipantInTxV1`
工厂，在 `session.transaction` 内部调用；参与者不持有裸 DB handle，作用域退出即失效。

### 3.3 执行 port

```ts
export interface ReactionExecutionPortV1 {
  launch(input: PreparedReactionExecutionV1, admission: ReactionExecutionAdmissionReceiptV1)
    : Promise<{ readonly executionRef: string }>
  inspect(access: ReactionExecutionAccessV1): Promise<ReactionExecutionSnapshotV1>
  inspectHumanReview(access: ReactionExecutionAccessV1): Promise<ReactionHumanReviewSnapshotV1>
  cancel(access: ReactionExecutionAccessV1): Promise<ReactionExecutionStopReceiptV1>
}
```

四个方法全必选。`ReactionExecutionAccessV1 = { admission, executionRef }`，要求
`executionRef === admission.executionRef`。

`ReactionExecutionSnapshotV1` 保留今天 `ReactionExecutionSnapshot` 的三态
（`pending` / `completed` / `failed`）与 `errorClass: WorkspaceFailureClass`、`metering` 字段——
**语义逐字不变**，只是 `outputJson: string` 换成 typed 的 `output`，`errorDetail: string` 换成
`diagnostics: ReactionDiagnosticsRef`。

`ReactionHumanReviewSnapshotV1` 是
`'not-applicable' | 'planning' | 'waiting' | 'approved' | 'failed'` 的 tagged union——
今天的 `null` 语义拆成 `not-applicable`（该动作没有闸门）与 provider 尚未推进（`planning`）。

## 4. 数据流

### 4.1 派发（替代 `execution-launch` outbox）

```
DE: dispatchOneReaction()
  ├─ 选一个 state='planned' 且 next_attempt_at <= now 的 round
  ├─ prepared = prepareReactionExecution({round, attempt, retryFeedbackRef})   // 纯函数
  └─ session.transaction(tx => {
        admission = admissionFactory(tx)
        fence   = admission.activateClaim({… expectedPreviousEpoch: round.claim_epoch,
                                              nextEpoch: round.claim_epoch + 1 })
        receipt = admission.admitLaunch({fence, operation, requestHash})   // ← record-before-act
        tx: round.claim_epoch = nextEpoch, round.state = 'dispatching'
     })                                                                    // 提交
  └─ port.launch(prepared, receipt)          // ← act，事务之外
  └─ store.markRoundRunning(roundId, executionRef)
```

**崩溃安全**：admission 行在 launch 之前就已提交，且带 `(operation, requestHash)` 唯一键。
崩溃后重来同一个 round 会算出**同一个 operation 与 requestHash**（两者只由 round 身份 +
attempt ordinal + 冻结的 plan 决定），TE 侧 `launch` 先查 admission 日志：
- 该 operation 已有 `execution_ref` ⇒ 原样返回，不建第二个任务；
- 尚无 ⇒ 建任务并在同一笔写回 `execution_ref`（record-before-act 的第二半）。

这取代 `56bb82b50` 的活性启发式（「按 round 反查看起来还活着的任务」）：不再推断活性，
按 operation 身份判定。那条回归锁随之迁到新合同上（AC-5）。

### 4.2 结算与重试

`inspectOneExecution()` 的循环形态不变，只是改传 `access`。重试仍由
`#retryOrFailExecution` 决定 ordinal / mode / 退避，但产物从「插一行 outbox」变成
「更新 round 的 `attempt_ordinal` / `next_attempt_at` / `retry_feedback_ref`」——
**退避公式、预算判据、场景切换规则一行不改**（AC-8 对拍）。

终态时在结算事务里调 `closeClaim`。

## 5. Schema（expand-only）

SQLite 迁移 `0230`，PostgreSQL 迁移 `0006`。

```sql
-- TE 拥有：admission 日志。record-before-act 的落点。
CREATE TABLE reaction_execution_admissions (
  operation_ref     TEXT PRIMARY KEY,
  case_id           TEXT NOT NULL,
  round_ref         TEXT NOT NULL,
  claim_epoch       INTEGER NOT NULL,
  fence_revision    INTEGER NOT NULL,
  request_hash      TEXT NOT NULL,
  authority_subject TEXT NOT NULL,
  authority_revision INTEGER NOT NULL,
  execution_ref     TEXT,                 -- launch 成功后写回
  state             TEXT NOT NULL,        -- admitted | launched | closed
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX reaction_execution_admissions_round_epoch
  ON reaction_execution_admissions (round_ref, claim_epoch);

-- DE 拥有：round 上的 claim 与调度列（原本长在 outbox 行上）
ALTER TABLE employee_reaction_rounds ADD COLUMN claim_epoch       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_reaction_rounds ADD COLUMN next_attempt_at   INTEGER;
ALTER TABLE employee_reaction_rounds ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_reaction_rounds ADD COLUMN last_dispatch_error TEXT;
ALTER TABLE employee_reaction_rounds ADD COLUMN retry_feedback_ref  TEXT;

-- DE 拥有：content-addressed 的重试反馈
CREATE TABLE employee_reaction_retry_feedback (
  digest     TEXT PRIMARY KEY,            -- sha256(裁剪后正文)
  body       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

`round.state` 枚举新增 `dispatching`（`planned → dispatching → running`）。
`dispatching` 是「admission 已登记、launch 尚未回执」的那一格，崩溃恢复看这一格就知道要重放。

**为什么不用 `EvidenceStore` 存反馈**：那是 `development-automation/infrastructure` 的资产，
DE 去用会新增一条跨 context 边，而反馈是有界小文本（≤4000 字符），DB 行足够且天然双引擎中立。

**在途数据迁移**：迁移把现存 `state IN ('pending','claimed')` 的 `execution-launch` outbox 行
逐行映射到对应 round 的 `next_attempt_at` / `dispatch_attempts` / `last_dispatch_error`，
然后删除这些行；`platform-work-item-execute` / `invocation-create` 行原样不动。
`kind` 的 CHECK 约束去掉 `execution-launch`。

## 6. 反馈裁剪（proposal §4 C1 的实现）

纯函数落在 `digital-employee/domain/retryFeedback.ts`：

```ts
export function sanitizeRetryFeedback(input: {
  readonly errorCode: string
  readonly errorDetail: string
  readonly workspaceRoot: string | null
}): { readonly body: string; readonly digest: string }
```

顺序：R2 路径改写 → R3 丢栈帧行 → R4 折叠重复行 → 拼 `errorCode: ` 前缀 → R5 截断 4000。
纯函数 + 可断言面，每条规则一个正向用例、R3/R4 各一个反例（AC-10）。

## 7. 失败模式

| 场景 | 行为 |
| --- | --- |
| admission 事务提交后、launch 前崩溃 | round 停在 `dispatching`；恢复后同 operation 重放，TE 查到无 `execution_ref` ⇒ 正常建任务 |
| launch 返回后、`markRoundRunning` 前崩溃 | admission 已有 `execution_ref`；重放直接拿回同一个 ref，不建第二个（AC-4/AC-5） |
| `activateClaim` 的 epoch CAS 失败 | 抛 `ConflictError('employee-reaction-claim-stale')`，本轮派发跳过，下一 tick 重来 |
| `launch` 本身抛错 | 不写 `execution_ref`；round 退回 `planned` 并按既有退避排下一次（等价于今天 outbox 的 `retryOutbox`） |
| 反馈 artifact 写入失败 | 降级成 `retryFeedback: {kind:'none'}` 并记 `last_dispatch_error`；**不阻塞重试**（今天 previousError 也不是必需品） |
| 同 digest 反馈重复写 | 主键冲突走 `onConflictDoNothing`，不新增行（AC-9） |

## 8. 测试策略

**首选可断言面（纯函数优先）**：
- `prepareReactionExecution`：工厂校验（initial ⇒ ordinal 0 + none）、deep-frozen、
  `requestHash` 排除 brand 与自身、同输入同 hash。
- `sanitizeRetryFeedback`：R1–R5 各一条正向 + R3/R4 各一条反例。
- `nextAttemptSchedule`：退避 / 预算 / 场景切换从 `#retryOrFailExecution` 抽出的纯判据，
  与改造前**逐值对拍**（AC-8）。

**双引擎集成（`describeEachProvider`）**：
- AC-3 同事务原子性：注入一个在 `admitLaunch` 后抛错的参与者，断言 round 的 claim epoch
  与 admission 行**都没落**。
- AC-4 重放幂等：同 operation 连调两次，`tasks` 里该 round 只有一行。
- AC-5 崩溃窗口：现有 `rfc294-e9c-…-crash-window` 的场景改用新合同重建。
- AC-9 content-addressed 去重。
- AC-11 人审闸门双引擎对拍。

**源码层兜底**：AC-1（四个标识符在 port 签名里计数为 0）、AC-2（optional 方法数 0）、
AC-7（`kind` 枚举不含 `execution-launch`）。

**不新增**：D2/D3 的并发 / 变异守卫矩阵。

## 9. 本 RFC 承担的架构演进 / 留下的债

**承担**：
- W4-E9 的 79 条 exact 债里，**销掉 DE↔TE 那 6 条双向类型边**（adapter→TE public 1 条、
  TE→DE public/types 4 条、TE→DE public/participants 1 条中属本合同的部分）。
- 消灭一处 provider 合同分叉源（optional 方法造成的引擎间行为差）。

**留下**：
- 43 条根 → `digital-employee/composition.ts` 与 4 条 route → composition：**归 E9-D**。
- `digitalEmployeeBuiltinToolCatalog` → `services/digitalEmployeeAgentTemplates.ts` 的 4 条：
  归 E9-D / W9（legacy 文件迁位）。
- observer / delivery worker 的 lifecycle 归属：归 W9。
