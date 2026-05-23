// RFC-061 PR-B — SignalKindHandler<'review'>
//
// review (RFC-005): the review NodeKind dispatches into suspend-direct
// (no opencode subprocess); user submits an `approve | iterate | reject`
// decision. applyResolution branches on the decision:
//
//   - approve: suspension-resolved + logical-run-completed on the review
//              node (no iter bump; just promotes to done state)
//   - iterate: suspension-resolved + logical-run-iter-bumped on the
//              UPSTREAM DESIGNER (not on the review node itself) so the
//              designer reruns with reviewer comments folded in.
//              The review node will re-suspend on the next round.
//   - reject:  suspension-resolved + logical-run-canceled
//
// effectOnLogicalRun returns 'depends-on-payload' since iter-bump applies
// only to iterate/reject; approve completes without bump.

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

export interface ReviewBody {
  docNodeId: string
  docPortName: string
  docContent: string
  reviewerHint?: string
}

export type ReviewDecisionKind = 'approve' | 'iterate' | 'reject'

export interface ReviewResolution {
  decision: ReviewDecisionKind
  /** Reviewer comments (required for iterate/reject; ignored for approve). */
  comments?: ReadonlyArray<{ filePath?: string; comment: string }>
  /** Free-form summary the reviewer wrote. */
  summary?: string
}

export interface ReviewExtras {
  /** Read the upstream designer's current scope so iterate targets it. */
  readDesignerScope: (docNodeId: string, atScope: Scope) => Promise<Scope | null>
}

export const reviewSignalKindHandler: SignalKindHandler<'review'> = {
  kind: 'review',

  async onSuspend(ctx: SuspendContext<'review'>, body: unknown): Promise<ReadonlyArray<Event>> {
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: Date.now(),
    }
    return [
      makeSuspensionCreatedEvent(ebCtx, newSuspensionId(), 'review', 'user:', body as ReviewBody),
    ]
  },

  validateResolution(payload: unknown): ValidationResult {
    const p = payload as Partial<ReviewResolution> | null
    if (!p || typeof p.decision !== 'string') {
      return { valid: false, reason: 'missing decision' }
    }
    if (p.decision !== 'approve' && p.decision !== 'iterate' && p.decision !== 'reject') {
      return { valid: false, reason: `unknown decision '${p.decision}'` }
    }
    if (p.decision !== 'approve') {
      if (!Array.isArray(p.comments) || p.comments.length === 0) {
        return { valid: false, reason: `${p.decision} requires non-empty comments array` }
      }
    }
    return { valid: true }
  },

  async applyResolution(
    ctx: ResolveContext<'review'>,
    payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const resolution = payload as ReviewResolution
    const extras = ctx as ResolveContext<'review'> & ReviewExtras
    const now = Date.now()
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: now,
    }
    const resolvedEvent = makeSuspensionResolvedEvent(
      ebCtx,
      ctx.suspensionId,
      'review',
      resolution,
      newResolutionId(),
      'user:',
    )

    if (resolution.decision === 'approve') {
      const completedEvent = makeLogicalRunCompletedEvent({ ...ebCtx, ts: now + 1 }, ctx.scope)
      return [resolvedEvent, completedEvent]
    }

    if (resolution.decision === 'reject') {
      const canceledEvent = makeLogicalRunCanceledEvent(
        { ...ebCtx, ts: now + 1 },
        ctx.scope,
        'review-rejected',
      )
      return [resolvedEvent, canceledEvent]
    }

    // decision === 'iterate' — bump designer's iter
    const body = findReviewBody(ctx.events, ctx.suspensionId)
    if (!body) {
      throw new Error(
        `review suspension ${ctx.suspensionId} has no matching suspension-created event in stream`,
      )
    }
    const designerScope = await extras.readDesignerScope(body.docNodeId, ctx.scope)
    if (!designerScope) {
      // Designer not yet materialized — just resolve; next dispatch picks up.
      return [resolvedEvent]
    }
    const bumpEvent = makeLogicalRunIterBumpedEvent(
      { ...ebCtx, ts: now + 1 },
      designerScope,
      resolvedEvent.id,
      'suspension-resolved',
    )
    return [resolvedEvent, bumpEvent]
  },

  effectOnLogicalRun() {
    return 'depends-on-payload'
  },

  renderPromptSection(resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    if (resolutions.length === 0) return ''
    const lines: string[] = ['<workflow-review-comments>']
    for (const r of resolutions) {
      const decision = r.payload.decision as ReviewResolution
      if (decision.decision === 'approve') continue // approve doesn't feed prompt
      if (decision.summary) lines.push(`  summary: ${decision.summary}`)
      for (const c of decision.comments ?? []) {
        if (c.filePath) {
          lines.push(`  - file: ${c.filePath}`)
        }
        lines.push(`    comment: ${c.comment}`)
      }
    }
    lines.push('</workflow-review-comments>')
    return lines.join('\n')
  },
}

function makeLogicalRunCompletedEvent(
  ctx: EventBuilderContext,
  scope: Scope,
): Event<'logical-run-completed'> {
  const id = `evt_${ulid()}`
  const payload = {}
  encodeEventPayload('logical-run-completed', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'logical-run-completed',
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

function findReviewBody(events: ReadonlyArray<Event>, suspensionId: string): ReviewBody | null {
  for (const e of events) {
    if (e.kind !== 'suspension-created') continue
    const p = e.payload
    if (
      typeof p === 'object' &&
      p !== null &&
      'suspensionId' in p &&
      (p as { suspensionId: string }).suspensionId === suspensionId
    ) {
      return (p as { body: ReviewBody }).body
    }
  }
  return null
}
