import {
  followupPolicyForFailure,
  type EnvelopeFollowupReason,
  type FailureCode,
  type PortValidationFailure,
} from '@agent-workflow/shared'

/** Default number of clean-session restarts for TaskExecution agent dispatch. */
export const DEFAULT_SESSION_RESTART_BUDGET = 1

export interface RetryShapeState {
  readonly followupChainLen: number
  readonly restartsUsed: number
}

export type RetryShape =
  | {
      readonly kind: 'followup'
      readonly reason: EnvelopeFollowupReason
      readonly failures: ReadonlyArray<PortValidationFailure>
    }
  | { readonly kind: 'restart'; readonly reason: EnvelopeFollowupReason }
  | { readonly kind: 'fresh' }

export type EnvelopeFollowupOutcome =
  | {
      readonly followup: true
      readonly reason: EnvelopeFollowupReason
      readonly failures: ReadonlyArray<PortValidationFailure>
    }
  | { readonly followup: false }

function normalizeBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/**
 * RFC-313/RFC-334 — TaskExecution's pure next-attempt shape decision.
 * The neutral attempt count lives in platform/contracts; session state stays here.
 */
export function decideRetryShape(input: {
  readonly followup: EnvelopeFollowupOutcome
  readonly state: RetryShapeState
  readonly followupBudget: number
  readonly restartBudget: number
  readonly suppressRestart?: boolean
}): { readonly shape: RetryShape; readonly next: RetryShapeState } {
  const followupBudget = normalizeBudget(input.followupBudget)
  const restartBudget = normalizeBudget(input.restartBudget)
  const { followupChainLen, restartsUsed } = input.state

  if (!input.followup.followup) {
    return { shape: { kind: 'fresh' }, next: { followupChainLen: 0, restartsUsed } }
  }

  const { reason, failures } = input.followup
  const keepFollowingUp = {
    shape: { kind: 'followup' as const, reason, failures },
    next: { followupChainLen: followupChainLen + 1, restartsUsed },
  }
  if (followupChainLen < followupBudget) return keepFollowingUp
  if (input.suppressRestart === true) return keepFollowingUp
  if (restartsUsed < restartBudget) {
    return {
      shape: { kind: 'restart' as const, reason },
      next: { followupChainLen: 0, restartsUsed: restartsUsed + 1 },
    }
  }
  return keepFollowingUp
}

// -----------------------------------------------------------------------------
// RFC-042 — same-session envelope follow-up decision.
// RFC-405: moved here from composition/nodeMechanics.ts beside decideRetryShape.
//
// When an attempt fails with a recognized envelope-format error (none / both /
// clarify-malformed) AND opencode itself exited cleanly AND we captured a
// session id AND the model emitted at least one text line, the next retry
// attempt should resume the SAME opencode session and send a short follow-up
// prompt (see shared `renderEnvelopeFollowupPrompt`) rather than rolling back
// to the pre-snapshot and starting from scratch. Any other failure shape —
// non-zero exit / crash / timeout / no session id captured / no text produced
// / non-envelope errorMessage — falls back to the legacy fresh-session retry
// path (rollback + new spawn).
//
// Pure function intentionally — easy to unit-test the 8-case truth table
// without standing up the whole scheduler.
// -----------------------------------------------------------------------------

export interface PreviousAttemptShape {
  status: 'done' | 'failed' | 'canceled' | null
  exitCode: number | null
  /**
   * RFC-145: the machine-readable failure taxonomy the runner declared at its
   * stamp point (persisted on `node_runs.failure_code`). Replaces the old
   * errorMessage-prefix parsing — errorMessage is human breadcrumbs only and
   * is deliberately NOT part of this shape anymore. NULL = no follow-up-able
   * failure (legacy rows were backfilled by migration 0077).
   */
  failureCode: FailureCode | null
  sessionId: string | null
  /** Count of `kind='text'` rows the runner persisted for the previous run. */
  agentTextCount: number
  /**
   * RFC-049: structured port-validation failures the previous attempt's
   * runner persisted to `node_runs.port_validation_failures_json`. Defaults
   * to undefined; callers that have the JSON-parsed array can thread it
   * through here so the scheduler can route per-kind repair text via
   * `composePerKindRepairBlocks`. When failureCode is 'port-validation-failed'
   * but this field is missing (e.g. legacy rows pre-RFC-049 / malformed JSON
   * degraded by parsePortValidationFailuresJson), the followup still fires but
   * `failures` in the decision is an empty array — degraded mode: prompt still
   * nudges the agent, just without per-port specifics.
   */
  portValidationFailures?: ReadonlyArray<{
    port: string
    kind: string
    subReason: string
    detail?: string
  }>
}

/**
 * RFC-042 的续跑判定结论。
 *
 * RFC-334 起它就是 TaskExecution 的 `EnvelopeFollowupOutcome` 本身，不再在
 * scheduler 里重述一遍结构。`decideRetryShape`（形状判定）与该值同属
 * task-execution/domain；渲染域 `reason` 与 `failures` 元素仍复用 shared 契约。
 */
export type EnvelopeFollowupDecision = EnvelopeFollowupOutcome

/**
 * RFC-145: table lookup replaces the old 7-branch order-sensitive
 * errorMessage-startsWith chain. The runner declares `failureCode` at the
 * same stamp that writes errorMessage; FOLLOWUP_POLICY (shared/prompt.ts)
 * projects the 7-value producer domain onto the 6-value render reason —
 * including the previously implicit clarify-forbidden → envelope-missing
 * downgrade, now an explicit table row. Order sensitivity is gone: the
 * runner distinguishes malformed-port vs port-validation at the source
 * (parse layer vs validation layer — mutually exclusive by construction).
 */
/**
 * RFC-313 实现门 P1-2 —— 框架自写的 `kind='text'` 审计事件的统一载荷前缀。
 *
 * 它们（`[rfc042/envelope-followup]` / `[rfc049/port-validation-followup]` /
 * `[rfc313/session-restart]`）与模型输出共用 `kind='text'`，因此「这一轮模型说过话吗」
 * 的计数必须把它们排除，否则判据恒真。三个 producer 与本前缀的一致性由
 * `packages/backend/tests/rfc313-source-locks.test.ts` 断言。
 */
export const FRAMEWORK_AUDIT_EVENT_PREFIX = '[rfc'

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount <= 0) return { followup: false }
  if (prev.failureCode === null) return { followup: false }
  const policy = followupPolicyForFailure(prev.failureCode)
  if (policy === undefined) return { followup: false }
  return {
    followup: true,
    reason: policy.reason,
    failures:
      prev.failureCode === 'port-validation-failed' ? (prev.portValidationFailures ?? []) : [],
  }
}

export function shouldRetryNodeFailure(
  failureCode: FailureCode | null | undefined,
  processUnreaped = false,
): boolean {
  // A fresh native session id does not conflict with the old id's lease. If
  // the old child may still be alive, retrying would therefore create two
  // writers in the same worktree even though both individual ids are leased.
  if (processUnreaped) return false
  // 2026-08-04 audit: a terminal error the RUNTIME reported about itself (auth
  // rejected, usage limit, gateway error) does not become true by replaying the
  // same inputs.
  if (failureCode === 'runtime-result-error') return false
  return true
}
