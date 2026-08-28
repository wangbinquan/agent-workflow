import type { EnvelopeFollowupReason, PortValidationFailure } from '@agent-workflow/shared'

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
