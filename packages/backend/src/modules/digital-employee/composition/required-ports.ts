import type { ExactResourceRef } from '../domain/model'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import type { ReactionExecutionPlan } from '../domain/runtimeModel'

export interface ToolConnectionProjection {
  readonly ref: ExactResourceRef
  readonly purpose: string
  readonly available: boolean
  readonly visible: boolean
  readonly contentDigest: string
  readonly closureSummary: string
}

export interface ToolConnectionVisibilitySubject {
  readonly userId: string
  readonly authority: {
    readonly bypass: boolean
    readonly private: boolean
  }
}

/**
 * Digital employees consume the platform-wide retry limits. This port is
 * intentionally read-only: authoring an employee must never create a second
 * retry-policy namespace beside Settings -> Limits.
 */
export interface EmployeeRetryLimitsPort {
  current(): {
    readonly defaultNodeRetries: number
    readonly sessionRestartBudget: number
  }
}

/**
 * Resolves one exact, platform-owned connection revision. The consumer owns
 * this narrow contract; provider credentials and executable details never
 * cross into Digital Employee authoring or Agent input.
 */
export interface ToolConnectionCatalogPort {
  resolve(
    ref: ExactResourceRef,
    subject?: ToolConnectionVisibilitySubject | null,
  ): Promise<ToolConnectionProjection | null>

  /**
   * Chooses a stable published Adapter for a compatible legacy upgrade.
   * Historical exact refs are preferences, not a requirement: providers may
   * fall back to their deterministic catalog default when those refs are
   * absent, archived, or ambiguous. An empty preference list means "use the
   * catalog default". The selected exact ref is frozen into the new revision.
   */
  selectAutomatic?(input: {
    readonly purpose: string
    readonly candidates: readonly ExactResourceRef[]
    readonly subject?: ToolConnectionVisibilitySubject | null
  }): Promise<ToolConnectionProjection | null>
}

export interface ProgramArtifactPort {
  put(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  }): Promise<{
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }>
  read(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }): {
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  } | null
}

/**
 * Content-addressed bytes are owned by the platform artifact mechanism. The
 * Digital Employee OS stores only an opaque blob ref and verified byte facts.
 */
export interface EmployeeInputArtifactPort {
  putFile(absolutePath: string): Promise<{
    readonly blobRef: string
    readonly sha256: string
    readonly bytes: number
  }>
  hasBlob(blobRef: string): boolean
  copyBlobTo(blobRef: string, absoluteTargetPath: string): void
}

export interface ReactionExecutionMetering {
  readonly sourceRef: string
  readonly durationMs: number
  readonly totalTokens: number
}

/**
 * Deterministic platform-owned work items (for example source-control publish
 * or merge-readiness evaluation) execute outside Agent/Workflow/Script. The
 * participant must return the same exact output envelope as every other tool.
 */
export interface PlatformWorkItemExecutionPort {
  execute(
    plan: ReactionExecutionPlan,
    context: {
      readonly publicationSubject:
        | { readonly kind: 'user'; readonly userId: string }
        | { readonly kind: 'system' }
    },
  ): Promise<string>
}

// ---------------------------------------------------------------------------
// RFC-368 T4 —— Reaction 执行的 V1 合同（DE 拥有，TaskExecution 实现）。
//
// 与它取代的旧字符串合同 `ReactionExecutionPort`（RFC-368 刀 3 删除）的区别，逐条都是
// 设计门 r1 或用户裁决的产物：
//   · 四个执行方法**全必选**——`inspectHumanReview?` 是 optional 时，PostgreSQL 侧曾整个缺席，
//     人审闸门在 PG 上永远报不出 `waiting`，而编译器一声不吭。
//   · `launch` 收 factory-built 的 `PreparedReactionExecutionV1` + admission 回执，
//     不再收裸 plan/attempt——跨缝的 JSON 往返（适配器 stringify → provider parse）随之消失。
//   · `previousError: string` 换成 content-addressed 的反馈 ref，正文经 reader port 解引用。
//   · snapshot 多一个 `stopped` 态：今天「取消」被 provider 当成 failed，DE 于是**白烧一次
//     重试预算**重新起任务（用户 2026-09-22 裁决顺带修）。
//   · `access` 是 `{operation, executionRef}` 而不是完整 receipt——receipt 在事务外重建不出来
//     （设计门 P1-5），两个字段都在 round 行上。
//
// 旧 port 在本刀里**保留**：刀 1 是纯增量，切换在刀 3。
// ---------------------------------------------------------------------------

import type {
  PreparedReactionExecutionV1,
  ReactionOperationRef,
  ReactionRequestHash,
  ReactionRetryFeedbackRef,
} from '../domain/reactionExecutionRequest'

export type {
  PreparedReactionExecutionV1,
  ReactionOperationRef,
  ReactionRequestHash,
  ReactionRetryFeedbackRef,
}

export type ReactionClaimEpoch = number & {
  readonly __reactionClaimEpoch: 'reaction-claim-epoch-v1'
}
export type ReactionDiagnosticsRef = string & {
  readonly __reactionDiagnostics: 'reaction-diagnostics-v1'
}
export type ReactionStopReceiptV1 = string & {
  readonly __reactionStopReceipt: 'reaction-execution-stopped-v1'
}

export interface ReactionClaimFenceReceiptV1 {
  readonly __brand: 'te-journal-backed-reaction-claim-fence-v1'
  readonly roundRef: string
  readonly claimEpoch: ReactionClaimEpoch
  readonly fenceRevision: number
  /**
   * `activateClaim` 收到的 case 与 authority 由 fence **带下去**给 `admitLaunch`。
   * 它是 provider 自己铸、自己消费的回执，让它承载这些比在 `admitLaunch` 上再要一遍好：
   * 两次调用之间这些值不可能变（同一笔事务、同一次 claim），再要一遍就多一处可以写错的地方。
   */
  readonly caseId: string
  readonly authority: { readonly subject: string; readonly revision: number }
}

export interface ReactionExecutionAdmissionReceiptV1 {
  readonly __brand: 'te-journal-backed-reaction-admission-v1'
  readonly fence: ReactionClaimFenceReceiptV1
  readonly operation: ReactionOperationRef
  readonly requestHash: ReactionRequestHash
  /**
   * **事务内预分配**的执行身份（用户 2026-09-22 裁决）。它必填，是 record-before-act 的关键：
   * launch 用这个 id 建任务，于是「任务已建、ref 还没写回」那一格根本不存在——崩溃重放
   * 按 operation 命中同一条 admission、拿回同一个 id，不会起第二个任务。
   */
  readonly execution: string
}

/**
 * 与 DE 的 claim CAS **同一个事务**。装配沿用仓内 `InTx` 定式：DE 注入
 * `(tx) => ReactionExecutionAdmissionParticipantV1`，在 `session.transaction` 内部取用；
 * 参与者不持裸 DB handle，作用域退出即失效。
 *
 * ⚠️ 类型名**刻意不叫** `…InTxV1`（RFC-294 §3.5 与 `REQUIRED_CONTEXT_EDGES` 的原名），
 * 也不带 `__brand`。本仓把名字以 `…InTx`/`…Authority`/`…Token` 结尾的类型当作**能力令牌**，
 * 由 `rfc294-architecture-preflight` 强制「只能由**声明它的 context** 里的 `create*` 工厂铸造、
 * 且该类型须声明在 `public/`」。而这是「DE 声明、TaskExecution 实现」的 **required port**——
 * 它按 RFC-294 就该待在 `composition/required-ports.ts`，且铸造权必然在实现方那边。
 * 占着能力令牌的后缀会让守卫要求一套结构上不可能满足的东西（实测：先报「在 owner factory
 * 之外构造」，包一层 DE 工厂后又报「factory is outside capability owner」）。
 * 见 design.md §2.2 的偏离项 D11。
 */
export interface ReactionExecutionAdmissionParticipantV1 {
  activateClaim(input: {
    readonly employeeCase: { readonly id: string }
    readonly reaction: { readonly roundRef: string }
    readonly expectedPreviousEpoch: ReactionClaimEpoch | null
    readonly nextEpoch: ReactionClaimEpoch
    readonly authority: { readonly subject: string; readonly revision: number }
  }): Promise<ReactionClaimFenceReceiptV1>
  /**
   * 对 `(operation, requestHash)` **幂等**：已登记则原样返回既有回执（含同一个 execution），
   * 同时把 fence 推进到当前 epoch。
   *
   * 这条幂等性是 P1-3 的解法：`operation` 是稳定键（round + ordinal），`claimEpoch` 是每次
   * 派发递增。两者都做唯一键必然互斥——同一个 ordinal 派发失败后重派就插不进去、round 卡死。
   */
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

export interface ReactionExecutionAccessV1 {
  readonly operation: ReactionOperationRef
  readonly executionRef: string
}

export type ReactionExecutionSnapshotV1 =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'completed'
      readonly outputJson: string
      readonly metering: ReactionExecutionMetering
    }
  | {
      readonly kind: 'failed'
      readonly errorClass: WorkspaceFailureClass
      readonly errorCode: string
      readonly diagnostics: ReactionDiagnosticsRef
      readonly metering: ReactionExecutionMetering
    }
  | {
      readonly kind: 'stopped'
      readonly receipt: ReactionStopReceiptV1
      readonly metering: ReactionExecutionMetering
    }

/**
 * 人审闸门的六态。`not-applicable` 与 `unknown` 是**两件事**，不能合并（设计门 P2-2）：
 *   · `not-applicable` —— 这个动作根本没配闸门（执行输入里没有闸门键）。投影成 `skipped`。
 *   · `unknown`        —— 执行行已不在 / 输入不可解析。投影端**保留今天的 round-state 回落**
 *                          （completed→approved / failed|obsolete→failed / 否则 planning）。
 * 合并的后果很具体：一个带闸门的动作正常完成、随后任务行被删（删除任务是既有功能），
 * 今天闸门显示「已批准」，合并后会变成「跳过」——语义错。
 */
export type ReactionHumanReviewSnapshotV1 =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'planning' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'approved' }
  | { readonly kind: 'failed' }

export interface ReactionExecutionPortV1 {
  launch(
    input: PreparedReactionExecutionV1,
    admission: ReactionExecutionAdmissionReceiptV1,
  ): Promise<{ readonly executionRef: string }>
  inspect(access: ReactionExecutionAccessV1): Promise<ReactionExecutionSnapshotV1>
  inspectHumanReview(access: ReactionExecutionAccessV1): Promise<ReactionHumanReviewSnapshotV1>
  cancel(access: ReactionExecutionAccessV1): Promise<ReactionStopReceiptV1>
}

/**
 * DE 拥有、**TaskExecution 消费**：把反馈 ref 解回正文拼进固定提示词。
 *
 * 没有它，`previousError` 换成 ref 之后 provider 手上只有一串 digest，重试提示里的纠错信息
 * 会整段消失（设计门 P1-8）。方向与其它 required port 一致（DE 声明、TE 依赖），不新增反向边。
 */
export interface ReactionRetryFeedbackReaderV1 {
  read(ref: ReactionRetryFeedbackRef): Promise<string | null>
}

/** DE 拥有、DE 自己消费：把诊断 ref 解回正文落 `round.outputJson` 与 `blockReason`。 */
export interface ReactionDiagnosticsReaderV1 {
  read(ref: ReactionDiagnosticsRef): Promise<string | null>
}

/**
 * DE 拥有、**TaskExecution 消费**：provider 把失败详情交给数字员工裁剪并按内容地址存档，
 * 执行 snapshot 上只回 ref（G5「port 上只传 ref」）。裁剪规则（R1–R5）在数字员工侧
 * `domain/reactionArtifacts.ts`，provider 不知道也不需要知道。
 */
export interface ReactionDiagnosticsSinkV1 {
  put(input: {
    readonly errorCode: string
    readonly errorDetail: string
    readonly workspaceRoot: string | null
  }): Promise<ReactionDiagnosticsRef>
}

/** 执行 snapshot 的失败类别；provider 适配器据此把自己的类别映射过来。 */
export type { WorkspaceFailureClass }
