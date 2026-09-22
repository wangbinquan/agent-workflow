// RFC-368 T1 —— Reaction 执行请求的**唯一铸造入口**。
//
// 今天跨到 TaskExecution 的那道缝上传的是 JSON 字符串：DE 的适配器
// （`application/adapters/task-execution-adapter.ts:7`）把 typed 的 plan `JSON.stringify` 一次，
// TE 那边（`composition/digitalEmployeeExecution.ts:397-400`）立刻 `JSON.parse` 回来，两边各
// 维护一份 zod schema——字段漂移编译器不管。这里换成一个 deep-frozen 的 typed 请求 + 内容哈希。
//
// `requestHash` 的用途是**重放命中**：崩溃后重来同一个 round 的同一个 attempt，必须算出同一个
// hash，才能命中 TE 那条已经登记的 admission、拿回同一个 executionRef，而不是再建一个任务。
// 因此 hash material 明确排除 brand 与 `requestHash` 自身（RFC-294 §3.5 / design.md D5）。
//
// ⚠️ 设计门 r1 的 P1-4：`plan` 必须取自 **round 行上已写回的冻结 plan**。今天
// `#retryOrFailExecution`（`runtimeService.ts:3200-3217`）按实时剩余预算重算 `roundBudgetMs` /
// `maxTotalTokens` 塞进 outbox payload，而 `round.planJson` 不更新——若沿用那个形状，重放时
// `consumedTotalTokens` 已经变了，hash 跟着变，「同 round 同 ordinal ⇒ 同 hash」不成立。
// 所以预算收敛必须在 `retryRound` 事务里写回 round（design.md §4.2），这里只读已冻结的值。

import { sha256Hex } from '@/util/hash'

import type { ReactionAttemptMode } from './retrySchedule'

export type ReactionOperationRef = string & {
  readonly __reactionOperation: 'reaction-operation-v1'
}
export type ReactionRequestHash = string & {
  readonly __reactionRequestHash: 'reaction-request-hash-v1'
}
export type ReactionRetryFeedbackRef = string & {
  readonly __reactionRetryFeedback: 'reaction-retry-feedback-v1'
}

export type ReactionRetryFeedbackV1 =
  | { readonly kind: 'none' }
  | { readonly kind: 'artifact'; readonly ref: ReactionRetryFeedbackRef }

export interface ReactionExecutionRequestV1 {
  readonly version: 1
  readonly operation: ReactionOperationRef
  readonly employeeCase: { readonly id: string; readonly revision: number }
  readonly reaction: { readonly roundRef: string }
  readonly authority: { readonly subject: string; readonly revision: number }
  readonly attempt: {
    readonly ordinal: number
    readonly mode: ReactionAttemptMode
    readonly retryFeedback: ReactionRetryFeedbackV1
  }
  /** `round.planJson` 的 typed 形态。本 RFC 只做 typed 化，不拆成五个冻结 ref（design.md D9）。 */
  readonly plan: Readonly<Record<string, unknown>>
}

export interface PreparedReactionExecutionV1 {
  readonly __brand: 'factory-built-deep-frozen-reaction-request-v1'
  readonly request: ReactionExecutionRequestV1
  readonly requestHash: ReactionRequestHash
}

/**
 * operation 是**稳定键**：同一个 round 的同一个 attempt ordinal 永远算出同一个值。
 * 派发失败后重派（claim epoch 递增）复用同一个 operation——这正是 admission 幂等的依据
 * （design.md §3.2 对 P1-3 的裁决：operation 做主键，epoch 是行上被更新的列）。
 */
export function reactionOperationRef(
  roundRef: string,
  attemptOrdinal: number,
): ReactionOperationRef {
  if (roundRef.length === 0) throw new Error('reaction operation requires roundRef')
  if (!Number.isInteger(attemptOrdinal) || attemptOrdinal < 0) {
    throw new Error(`reaction operation requires a nonnegative integer ordinal: ${attemptOrdinal}`)
  }
  return `reaction:${roundRef}:${attemptOrdinal}` as ReactionOperationRef
}

/** 稳定序列化：对象键排序，数组顺序保留。hash 必须与键的书写顺序无关。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  }
  return value
}

export function reactionRequestHash(request: ReactionExecutionRequestV1): ReactionRequestHash {
  return sha256Hex(JSON.stringify(canonical(request))) as ReactionRequestHash
}

/**
 * 唯一铸造入口。外部 caller / route / bootstrap / TaskExecution 都不能 object-literal 出一个
 * `PreparedReactionExecutionV1`——brand 与 deep-freeze 都只在这里发生。
 */
export function prepareReactionExecution(input: {
  readonly employeeCase: { readonly id: string; readonly revision: number }
  readonly roundRef: string
  readonly authority: { readonly subject: string; readonly revision: number }
  readonly attempt: {
    readonly ordinal: number
    readonly mode: ReactionAttemptMode
    readonly retryFeedback: ReactionRetryFeedbackV1
  }
  readonly plan: Readonly<Record<string, unknown>>
}): PreparedReactionExecutionV1 {
  const { ordinal, mode, retryFeedback } = input.attempt
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`reaction attempt ordinal must be a nonnegative integer: ${ordinal}`)
  }
  // 0-based 是行为兼容的一部分（RFC-294 §3.5）：initial 必须是第 0 次且不带纠错反馈——
  // 带了就说明调用方把某次重试当成了首次，那会让 agent 收到上一轮的错误当作本轮前提。
  if (mode === 'initial' && ordinal !== 0) {
    throw new Error(`initial reaction attempt must have ordinal 0, got ${ordinal}`)
  }
  if (mode === 'initial' && retryFeedback.kind !== 'none') {
    throw new Error('initial reaction attempt must not carry retry feedback')
  }
  if (mode !== 'initial' && ordinal === 0) {
    throw new Error(`retry reaction attempt must not have ordinal 0 (mode ${mode})`)
  }
  const request: ReactionExecutionRequestV1 = {
    version: 1,
    operation: reactionOperationRef(input.roundRef, ordinal),
    employeeCase: { id: input.employeeCase.id, revision: input.employeeCase.revision },
    reaction: { roundRef: input.roundRef },
    authority: { subject: input.authority.subject, revision: input.authority.revision },
    attempt: { ordinal, mode, retryFeedback },
    plan: input.plan,
  }
  deepFreeze(request)
  return deepFreeze({
    __brand: 'factory-built-deep-frozen-reaction-request-v1',
    request,
    requestHash: reactionRequestHash(request),
  }) as PreparedReactionExecutionV1
}
