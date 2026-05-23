// RFC-061 PR-B — SignalKindHandler<'cross-clarify'>
//
// cross-clarify (RFC-056 / RFC-059): downstream questioner agent emits
// <workflow-clarify>question</workflow-clarify>; the runner creates a
// suspension on the clarify-cross-agent NodeKind awaiting human triage
// (submit → designer rerun; reject → questioner rerun w/ rejection text;
// stop → persistent stop short-circuit).
//
// Resolution decisions (mirror existing crossClarify.ts service shapes):
//   - submit:   feedback flows to upstream designer; bump-iter on the
//               designer's logical_run AND cascade through any other
//               questioner nodes wired to the same designer
//               (RFC-056 patch-3 cascade)
//   - reject:   feedback flows to the questioner with the human's text;
//               bump-iter on the questioner's logical_run
//   - stop:     persistent stop (RFC-056 patch-4); written as a
//               suspension-resolved with decision.directive='stop'; no
//               iter bumps. Future cross-clarify dispatches on the same
//               node short-circuit (handled by NodeKindHandler dispatch).
//
// Per-question scope (RFC-059): when the user submits per-question
// scopes, the resolution decision carries per-question targeting; this
// handler emits the right iter-bump set.

import type {
  SignalKindHandler,
  SuspendContext,
  ResolveContext,
  ValidationResult,
  Event,
  Scope,
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

export interface CrossClarifyBody {
  /** The questioner that asked. */
  questionerNodeId: string
  /** The designer it's targeting (resolved by graph topology). */
  designerNodeId: string
  questions: ReadonlyArray<{ id: string; text: string }>
  /** Per-question scope hints (RFC-059). */
  questionScopes?: Record<string, 'this-designer' | 'all-designers'>
}

export type CrossClarifyDirective = 'submit' | 'reject' | 'stop'

export interface CrossClarifyResolution {
  directive: CrossClarifyDirective
  /** When directive='submit' or 'reject', per-question human text. */
  answers?: ReadonlyArray<{ questionId: string; text: string }>
  /** When directive='reject', also feedback text for the questioner. */
  rejectionFeedback?: string
}

export interface CrossClarifyExtras {
  /**
   * Read the designer's current scope so the iter-bump targets the right
   * row. Closure injected by the taskActor (knows projection layout).
   */
  readDesignerScope: (designerNodeId: string, atScope: Scope) => Promise<Scope | null>
  /**
   * For cascade: list other questioners wired to the same designer that
   * also need bump-iter when this submission propagates.
   */
  cascadeQuestioners: (designerNodeId: string, atScope: Scope) => Promise<ReadonlyArray<Scope>>
}

export const crossClarifySignalKindHandler: SignalKindHandler<'cross-clarify'> = {
  kind: 'cross-clarify',

  async onSuspend(
    ctx: SuspendContext<'cross-clarify'>,
    body: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: Date.now(),
    }
    const event = makeSuspensionCreatedEvent(
      ebCtx,
      newSuspensionId(),
      'cross-clarify',
      'user:',
      body as CrossClarifyBody,
    )
    return [event]
  },

  validateResolution(payload: unknown): ValidationResult {
    const p = payload as Partial<CrossClarifyResolution> | null
    if (!p || typeof p.directive !== 'string') {
      return { valid: false, reason: 'missing directive' }
    }
    if (p.directive !== 'submit' && p.directive !== 'reject' && p.directive !== 'stop') {
      return { valid: false, reason: `unknown directive '${p.directive}'` }
    }
    if ((p.directive === 'submit' || p.directive === 'reject') && !Array.isArray(p.answers)) {
      return { valid: false, reason: `${p.directive} requires answers array` }
    }
    if (p.directive === 'reject' && typeof p.rejectionFeedback !== 'string') {
      return { valid: false, reason: 'reject requires rejectionFeedback' }
    }
    return { valid: true }
  },

  async applyResolution(
    ctx: ResolveContext<'cross-clarify'>,
    payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const resolution = payload as CrossClarifyResolution
    const extras = ctx as ResolveContext<'cross-clarify'> & CrossClarifyExtras
    const now = Date.now()
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: now,
    }
    const resolvedEvent = makeSuspensionResolvedEvent(
      ebCtx,
      ctx.suspensionId,
      'cross-clarify',
      resolution,
      newResolutionId(),
      'user:',
    )

    if (resolution.directive === 'stop') {
      // Persistent stop — only emit the suspension-resolved event.
      return [resolvedEvent]
    }

    if (resolution.directive === 'reject') {
      // Bump the questioner so it re-dispatches with rejection feedback.
      const questionerBump = makeLogicalRunIterBumpedEvent(
        { ...ebCtx, ts: now + 1 },
        ctx.scope,
        resolvedEvent.id,
        'suspension-resolved',
      )
      return [resolvedEvent, questionerBump]
    }

    // directive === 'submit': bump designer + cascade
    const body = findCrossClarifyBody(ctx.events, ctx.suspensionId)
    if (!body) {
      throw new Error(
        `cross-clarify suspension ${ctx.suspensionId} has no matching suspension-created event in stream`,
      )
    }
    const designerScope = await extras.readDesignerScope(body.designerNodeId, ctx.scope)
    if (!designerScope) {
      // No designer scope materialized yet — defensive: just resolve the
      // suspension; the next ready scan will pick up the designer at iter=0.
      return [resolvedEvent]
    }
    const cascadeScopes = await extras.cascadeQuestioners(body.designerNodeId, ctx.scope)
    const bumps: Event[] = []
    bumps.push(
      makeLogicalRunIterBumpedEvent(
        { ...ebCtx, ts: now + 1 },
        designerScope,
        resolvedEvent.id,
        'suspension-resolved',
      ),
    )
    let tsCursor = now + 2
    for (const sc of cascadeScopes) {
      // Avoid double-bumping the current questioner; it will re-dispatch
      // naturally when the designer's new output flows downstream.
      if (sameScope(sc, ctx.scope)) continue
      bumps.push(
        makeLogicalRunIterBumpedEvent(
          { ...ebCtx, ts: tsCursor++ },
          sc,
          resolvedEvent.id,
          'suspension-resolved',
        ),
      )
    }
    return [resolvedEvent, ...bumps]
  },

  effectOnLogicalRun() {
    return 'bump-iter'
  },

  renderPromptSection(resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    if (resolutions.length === 0) return ''
    const lines: string[] = ['<workflow-cross-clarify>']
    for (const r of resolutions) {
      const decision = r.payload.decision as CrossClarifyResolution
      if (decision.directive === 'stop') {
        lines.push('  [persistent-stop]')
        continue
      }
      lines.push(`  directive: ${decision.directive}`)
      for (const a of decision.answers ?? []) {
        lines.push(`  Q[${a.questionId}]: ${a.text}`)
      }
      if (decision.directive === 'reject' && decision.rejectionFeedback) {
        lines.push(`  rejected: ${decision.rejectionFeedback}`)
      }
    }
    lines.push('</workflow-cross-clarify>')
    return lines.join('\n')
  },
}

function findCrossClarifyBody(
  events: ReadonlyArray<Event>,
  suspensionId: string,
): CrossClarifyBody | null {
  for (const e of events) {
    if (e.kind !== 'suspension-created') continue
    const p = e.payload
    if (
      typeof p === 'object' &&
      p !== null &&
      'suspensionId' in p &&
      (p as { suspensionId: string }).suspensionId === suspensionId
    ) {
      return (p as { body: CrossClarifyBody }).body
    }
  }
  return null
}

function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.loopIter === b.loopIter &&
    a.shardKey === b.shardKey &&
    a.iter === b.iter
  )
}
