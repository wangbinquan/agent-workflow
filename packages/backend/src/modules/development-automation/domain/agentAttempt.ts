// RFC-310 PR-4 T42/T49 —— AgentAttempt 状态机、两级预算与 baseline 复合 ref。
//
// 业务层 attempt（§7.1）：属于哪个 ActionRun、rerunSeq/attemptSeq、协议拒绝、
// 最终 outcome。机制层（Task/session/进程）归 task-execution，两边只用
// opaque AgentExecutionRef 关联。
//
// 两级重试（§7.7）：same-session 里 protocol/semantic 失败给 structured
// feedback 重试（attemptSeq+1）；预算耗尽 → 终止 session、revoke 能力、
// **整树废弃**（绝不 git reset）、exact baseline 重建、新 nonce fresh rerun
// （rerunSeq+1、attemptSeq 归零、不带旧 feedback）。boundary violation 禁止
// same-session、允许 fresh 但计入同一 fresh 预算（安全预算不单列，收紧留后续）。

import { z } from 'zod'

import { canonicalStringify } from './canonicalJson'
import { sha256Hex } from '@/util/hash'

export const AGENT_ATTEMPT_STATUSES = [
  'claimed',
  'running',
  'rejected',
  'validated',
  'interrupted',
  'discarded',
] as const

export type AgentAttemptStatus = (typeof AGENT_ATTEMPT_STATUSES)[number]

/** 终态吸收：rejected/validated/interrupted/discarded 均不再转移。 */
export const ATTEMPT_TRANSITIONS: Readonly<
  Record<AgentAttemptStatus, readonly AgentAttemptStatus[]>
> = {
  claimed: ['running', 'interrupted', 'discarded'],
  running: ['rejected', 'validated', 'interrupted', 'discarded'],
  rejected: [],
  validated: [],
  interrupted: [],
  discarded: [],
}

export function checkAttemptTransition(input: {
  readonly from: AgentAttemptStatus
  readonly to: AgentAttemptStatus
}): { readonly ok: true } | { readonly ok: false; readonly code: 'illegal-transition' } {
  return ATTEMPT_TRANSITIONS[input.from].includes(input.to)
    ? { ok: true }
    : { ok: false, code: 'illegal-transition' }
}

/**
 * baseline 复合 ref（§7.2 尾段）：不总等于 Git head——精确表示
 * `repository snapshot + pending SeedChangeRef + prior validated change sets`。
 * Agent 的 no-change 相对它判断；发布 candidate 始终相对 repository snapshot。
 */
export const agentAttemptBaselineSchema = z
  .object({
    repositorySnapshotRef: z.string().min(1),
    seedChangeRef: z.string().min(1).nullable(),
    priorChangeSetRefs: z.array(z.string().min(1)),
  })
  .strict()

export type AgentAttemptBaseline = z.infer<typeof agentAttemptBaselineSchema>

const BASELINE_REF_PREFIX = 'ab1:'

export function encodeAgentAttemptBaselineRef(baseline: AgentAttemptBaseline): string {
  return (
    BASELINE_REF_PREFIX +
    Buffer.from(canonicalStringify(agentAttemptBaselineSchema.parse(baseline))).toString(
      'base64url',
    )
  )
}

export function decodeAgentAttemptBaselineRef(ref: string): AgentAttemptBaseline | null {
  if (!ref.startsWith(BASELINE_REF_PREFIX)) return null
  try {
    const json: unknown = JSON.parse(
      Buffer.from(ref.slice(BASELINE_REF_PREFIX.length), 'base64url').toString('utf8'),
    )
    const parsed = agentAttemptBaselineSchema.safeParse(json)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** nonce 明文只在 protocol block 与 parser 内存中存在；台账只持 digest（§7.1）。 */
export function nonceDigestOf(nonce: string): string {
  return sha256Hex(nonce)
}

/** structured feedback（§7.7 尾）：不是自由文本、不含 secret/raw log。 */
export const attemptFeedbackSchema = z
  .object({
    code: z.string().min(1).max(120),
    jsonPointer: z.string().max(500).nullable(),
    expected: z.string().max(500).nullable(),
    observedSummary: z.string().min(1).max(500),
    retryOrdinal: z.number().int().nonnegative(),
  })
  .strict()

export type AttemptFeedback = z.infer<typeof attemptFeedbackSchema>

export type AttemptFailureKind =
  /** missing/multiple envelope、schema、semantic mismatch（§7.7 表第 1 行）。 */
  | 'protocol'
  /** runtime transient 且完整性 receipt 可信（第 2 行）。 */
  | 'runtime-transient'
  /** Git/protected/evidence 写入等快照检出（第 3 行）。 */
  | 'boundary-violation'
  /** baseline/evidence digest 不可重建（第 4 行）。 */
  | 'evidence-unavailable'
  /** cancel、terminal MR、epoch lost（第 5 行）。 */
  | 'superseded'

export interface AttemptBudget {
  readonly sameSession: number
  readonly freshSession: number
}

export type NextAttemptPlan =
  | { readonly kind: 'same-session'; readonly rerunSeq: number; readonly attemptSeq: number }
  | { readonly kind: 'fresh-session'; readonly rerunSeq: number; readonly attemptSeq: 0 }
  | { readonly kind: 'exhausted'; readonly blockCode: 'agent-contract-exhausted' }
  | { readonly kind: 'forbidden'; readonly blockCode: string }

/**
 * §7.7 分类表的纯函数化。sameSession 预算 = 同一 rerun 内**重试**次数上限
 * （attemptSeq 从 0 起，attemptSeq < sameSession ⇒ 还可 +1）；freshSession
 * 预算 = 额外 fresh rerun 次数上限（rerunSeq < freshSession ⇒ 还可 +1）。
 */
export function planNextAttempt(input: {
  readonly failure: AttemptFailureKind
  readonly budget: AttemptBudget
  readonly rerunSeq: number
  readonly attemptSeq: number
}): NextAttemptPlan {
  const { failure, budget, rerunSeq, attemptSeq } = input
  const freshAllowed = rerunSeq < budget.freshSession
  switch (failure) {
    case 'protocol':
    case 'runtime-transient': {
      if (attemptSeq < budget.sameSession) {
        return { kind: 'same-session', rerunSeq, attemptSeq: attemptSeq + 1 }
      }
      return freshAllowed
        ? { kind: 'fresh-session', rerunSeq: rerunSeq + 1, attemptSeq: 0 }
        : { kind: 'exhausted', blockCode: 'agent-contract-exhausted' }
    }
    case 'boundary-violation': {
      // same-session 禁止：现场已不可信，立即 kill/revoke/整树废弃。
      return freshAllowed
        ? { kind: 'fresh-session', rerunSeq: rerunSeq + 1, attemptSeq: 0 }
        : { kind: 'exhausted', blockCode: 'agent-contract-exhausted' }
    }
    case 'evidence-unavailable':
      return { kind: 'forbidden', blockCode: 'evidence-unavailable' }
    case 'superseded':
      return { kind: 'forbidden', blockCode: 'attempt-superseded' }
  }
}
