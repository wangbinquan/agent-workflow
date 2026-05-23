// RFC-061 PR-B — SignalKindHandler<'retry-pending-human'>
//
// retry-pending-human: emitted when the auto retry budget is exhausted.
// The logical_run parks awaiting a user decision: retry (manual budget
// override), give-up (logical-run-canceled), or escalate (just keeps the
// suspension open for triage).
//
// applyResolution branches:
//   - retry:    suspension-resolved + logical-run-iter-bumped (fresh attempt)
//   - give-up:  suspension-resolved + logical-run-canceled
//   - escalate: this is a non-action; resolve the suspension but no further
//               event. The user can act later by submitting another resolution
//               (a new suspension would need to be minted by the actor).

import type {
  SignalKindHandler,
  SuspendContext,
  ResolveContext,
  ValidationResult,
  Event,
  Scope,
} from '@agent-workflow/shared'
import { encodeEventPayload } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import {
  inferTaskId,
  makeLogicalRunIterBumpedEvent,
  makeSuspensionCreatedEvent,
  makeSuspensionResolvedEvent,
  newResolutionId,
  newSuspensionId,
  type EventBuilderContext,
} from './_eventBuilders'

export interface RetryPendingHumanBody {
  /** Outcome history that brought us here. */
  outcomes: ReadonlyArray<'envelope-fail' | 'crash' | 'timeout'>
  /** All prior attempt IDs (newest last). */
  attemptIds: ReadonlyArray<string>
  /** Last attempt's reason text. */
  reason: string
}

export type HumanRetryDecision = 'retry' | 'give-up' | 'escalate'

export interface RetryPendingHumanResolution {
  decision: HumanRetryDecision
  /** Optional human note for the audit log. */
  note?: string
}

export const retryPendingHumanSignalKindHandler: SignalKindHandler<'retry-pending-human'> = {
  kind: 'retry-pending-human',

  async onSuspend(
    ctx: SuspendContext<'retry-pending-human'>,
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
        'retry-pending-human',
        'user:',
        body as RetryPendingHumanBody,
      ),
    ]
  },

  validateResolution(payload: unknown): ValidationResult {
    const p = payload as Partial<RetryPendingHumanResolution> | null
    if (!p || typeof p.decision !== 'string') {
      return { valid: false, reason: 'missing decision' }
    }
    if (p.decision !== 'retry' && p.decision !== 'give-up' && p.decision !== 'escalate') {
      return { valid: false, reason: `unknown decision '${p.decision}'` }
    }
    return { valid: true }
  },

  async applyResolution(
    ctx: ResolveContext<'retry-pending-human'>,
    payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const resolution = payload as RetryPendingHumanResolution
    const now = Date.now()
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: now,
    }
    const resolvedEvent = makeSuspensionResolvedEvent(
      ebCtx,
      ctx.suspensionId,
      'retry-pending-human',
      resolution,
      newResolutionId(),
      'user:',
    )

    if (resolution.decision === 'escalate') {
      // No additional event — the user is just acknowledging; future
      // suspensions can be minted by the actor as needed.
      return [resolvedEvent]
    }

    if (resolution.decision === 'give-up') {
      const canceledEvent = makeLogicalRunCanceledEvent(
        { ...ebCtx, ts: now + 1 },
        ctx.scope,
        'human-give-up',
      )
      return [resolvedEvent, canceledEvent]
    }

    // decision === 'retry'
    const bumpEvent = makeLogicalRunIterBumpedEvent(
      { ...ebCtx, ts: now + 1 },
      ctx.scope,
      resolvedEvent.id,
      'suspension-resolved',
    )
    return [resolvedEvent, bumpEvent]
  },

  effectOnLogicalRun() {
    return 'depends-on-payload'
  },

  renderPromptSection(_resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    return ''
  },

  // No autoResolve — user must act.
}

function makeLogicalRunCanceledEvent(
  ctx: EventBuilderContext,
  scope: Scope,
  reason: string,
): Event<'logical-run-canceled'> {
  const id = `evt_${ulid()}`
  const payload = { reason }
  encodeEventPayload('logical-run-canceled', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'logical-run-canceled',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}
