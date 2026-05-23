// RFC-061 PR-B — SignalKindHandler<'retry-pending-auto'>
//
// retry-pending-auto: emitted by the taskActor when an attempt finishes
// envelope-fail / crash / timeout AND the node's retry budget is non-zero.
// The handler's autoResolve fires immediately (budget>0): returns a
// resolution payload that applyResolution turns into `suspension-resolved
// + logical-run-iter-bumped`. The taskActor then re-dispatches at iter+1
// which spawns a fresh attempt.
//
// RFC-042 envelope-followup decision: when a prior attempt's envelope was
// malformed (no closing tag, missing port, etc.), the resolution carries
// `followupAction`: keep-session means the new attempt resumes the same
// opencode session; isolate means a fresh session. This is signaled in
// the resolution payload so the runner (later in PR-B T9) reads it when
// it spawns the next attempt.
//
// budget=0 → handler bumps to retry-pending-human (NOT covered here;
// the taskActor's onAttemptFinished mapping handles the budget check
// before deciding which signal to emit).

import type {
  SignalKindHandler,
  SuspendContext,
  ResolveContext,
  ValidationResult,
  SuspensionRecord,
  Event,
} from '@agent-workflow/shared'

import {
  inferTaskId,
  makeLogicalRunIterBumpedEvent,
  makeSuspensionCreatedEvent,
  makeSuspensionResolvedEvent,
  newResolutionId,
  newSuspensionId,
  type EventBuilderContext,
} from './_eventBuilders'

export interface RetryPendingAutoBody {
  /** Outcome that triggered the retry. */
  outcome: 'envelope-fail' | 'crash' | 'timeout'
  /** Last attempt's id (for follow-up session decision). */
  lastAttemptId: string
  /** Reason text from the last attempt (envelope-fail message, crash log, etc.) */
  reason: string
  /** How many retries left before escalating to retry-pending-human. */
  remainingBudget: number
}

export type RetryFollowupAction = 'keep-session' | 'isolate'

export interface RetryPendingAutoResolution {
  followupAction: RetryFollowupAction
  /** What budget decrement to apply. Defaults to 1; tests / edge cases may differ. */
  budgetDecrement?: number
}

export const retryPendingAutoSignalKindHandler: SignalKindHandler<'retry-pending-auto'> = {
  kind: 'retry-pending-auto',

  async onSuspend(
    ctx: SuspendContext<'retry-pending-auto'>,
    body: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: Date.now(),
    }
    return [
      makeSuspensionCreatedEvent(
        ebCtx,
        newSuspensionId(),
        'retry-pending-auto',
        'system',
        body as RetryPendingAutoBody,
      ),
    ]
  },

  validateResolution(payload: unknown): ValidationResult {
    const p = payload as Partial<RetryPendingAutoResolution> | null
    if (!p || typeof p.followupAction !== 'string') {
      return { valid: false, reason: 'missing followupAction' }
    }
    if (p.followupAction !== 'keep-session' && p.followupAction !== 'isolate') {
      return { valid: false, reason: `unknown followupAction '${p.followupAction}'` }
    }
    return { valid: true }
  },

  async applyResolution(
    ctx: ResolveContext<'retry-pending-auto'>,
    payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const resolution = payload as RetryPendingAutoResolution
    const now = Date.now()
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: now,
    }
    const resolvedEvent = makeSuspensionResolvedEvent(
      ebCtx,
      ctx.suspensionId,
      'retry-pending-auto',
      resolution,
      newResolutionId(),
      'system',
    )
    const bumpEvent = makeLogicalRunIterBumpedEvent(
      { ...ebCtx, ts: now + 1 },
      ctx.scope,
      resolvedEvent.id,
      'suspension-resolved',
    )
    return [resolvedEvent, bumpEvent]
  },

  async autoResolve(suspension: SuspensionRecord): Promise<unknown | null> {
    const body = suspension.body as RetryPendingAutoBody | null
    if (!body) return null
    if (body.remainingBudget <= 0) return null
    // Default policy: envelope-fail keeps the session (RFC-042 follow-up);
    // crash/timeout isolate (fresh session because state may be corrupt).
    const followupAction: RetryFollowupAction =
      body.outcome === 'envelope-fail' ? 'keep-session' : 'isolate'
    return { followupAction, budgetDecrement: 1 } satisfies RetryPendingAutoResolution
  },

  effectOnLogicalRun() {
    return 'bump-iter'
  },

  renderPromptSection(_resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    // retry-pending-* is a control signal, not feedback — never enters prompt.
    return ''
  },
}
