// RFC-061 PR-B — SignalKindHandler<'self-clarify'>
//
// self-clarify (RFC-023): an agent emits <workflow-clarify>question</workflow-clarify>
// mid-attempt; the runner intercepts and creates a suspension on this
// agent's logical_run. User answers via REST; applyResolution writes
// `suspension-resolved` + `logical-run-iter-bumped` so the agent re-dispatches
// at next iter with the Q&A folded into its prompt context.
//
// SignalKind contract (design.md §4):
//   - effectOnLogicalRun: bump-iter
//   - autoResolve: ✗ (user-driven)
//   - renderPromptSection: pulls Q&A pairs from suspension-resolved events
//     and formats them as "<workflow-self-clarify>\n  Q[id]:\n  A: ...\n</workflow-self-clarify>"

import type {
  SignalKindHandler,
  SuspendContext,
  ResolveContext,
  ValidationResult,
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

/** Body of a self-clarify suspension — the question(s) the agent asked. */
export interface SelfClarifyBody {
  questions: ReadonlyArray<{ id: string; text: string }>
  questionContext?: Record<string, string>
}

/** Payload of the user's resolution — one answer per question. */
export interface SelfClarifyResolution {
  answers: ReadonlyArray<{ questionId: string; text: string }>
}

export const selfClarifySignalKindHandler: SignalKindHandler<'self-clarify'> = {
  kind: 'self-clarify',

  async onSuspend(
    ctx: SuspendContext<'self-clarify'>,
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
      'self-clarify',
      'user:',
      body as SelfClarifyBody,
    )
    return [event]
  },

  validateResolution(payload: unknown): ValidationResult {
    const p = payload as Partial<SelfClarifyResolution> | null
    if (!p || !Array.isArray(p.answers)) {
      return { valid: false, reason: 'missing answers array' }
    }
    for (const a of p.answers) {
      if (!a || typeof a.questionId !== 'string' || typeof a.text !== 'string') {
        return { valid: false, reason: 'each answer needs questionId + text' }
      }
    }
    return { valid: true }
  },

  async applyResolution(
    ctx: ResolveContext<'self-clarify'>,
    payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    const resolution = payload as SelfClarifyResolution
    const now = Date.now()
    const ebCtx: EventBuilderContext = {
      taskId: inferTaskId(ctx.events),
      scope: ctx.scope,
      ts: now,
    }
    const resolvedEvent = makeSuspensionResolvedEvent(
      ebCtx,
      ctx.suspensionId,
      'self-clarify',
      resolution,
      newResolutionId(),
      'user:',
    )
    const bumpEvent = makeLogicalRunIterBumpedEvent(
      { ...ebCtx, ts: now + 1 },
      ctx.scope,
      resolvedEvent.id,
      'suspension-resolved',
    )
    return [resolvedEvent, bumpEvent]
  },

  effectOnLogicalRun() {
    return 'bump-iter'
  },

  renderPromptSection(resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    if (resolutions.length === 0) return ''
    const lines: string[] = ['<workflow-self-clarify>']
    for (const r of resolutions) {
      const decision = r.payload.decision as SelfClarifyResolution
      for (const a of decision.answers) {
        lines.push(`  Q[${a.questionId}]:`)
        lines.push(`  A: ${a.text}`)
      }
    }
    lines.push('</workflow-self-clarify>')
    return lines.join('\n')
  },
}
