// RFC-304 — the code work item's lifecycle, as a pure decision function.
//
// A work item is the thing being followed up on: one MR's review, one MR's
// monitoring, one issue's implementation. It lives an order of magnitude longer
// than a task — across events, across days — which is exactly why it needs its
// own state machine rather than borrowing the task's (design §D2: waiting for a
// human happens HERE, so no task is left hanging for three days).
//
// Shape follows `services/lifecycle.ts`: a pure function decides the next
// status, and the caller does the CAS write (`WHERE id = ? AND status = from`).
// Keeping the decision pure is what makes the transition table exhaustively
// testable — the interesting part of this machine is not the happy path but the
// guard ORDER, and guard order is invisible in an integration test.
//
// Why guards need an explicit priority (design §2.2): one real-world event can
// match several rows at once. A teammate pushing a new commit while the item is
// `awaiting` is BOTH "an external event arrived" AND "the baseline changed". If
// the machine resolves that by table order, behaviour depends on how the table
// happens to be written down. So the three rules are stated and enforced here:
//
//   1. Baseline change wins. A head change during `awaiting` is always consumed
//      as invalidation (settle + tell the human why), never as a wake-up.
//   2. A confirmation only wakes the item if its generation matches the pending
//      one. A late confirmation aimed at a superseded patch is dropped with an
//      explanation, not acted on.
//   3. Ordinary notes and pipeline events never wake an item that is waiting for
//      a push confirmation.

export const CODE_WORK_ITEM_STATUSES = [
  'idle',
  'queued',
  'running',
  'awaiting',
  'settled',
  'failed',
  'superseding',
  'handed_off',
  'closing',
  'closed',
] as const
export type CodeWorkItemStatus = (typeof CODE_WORK_ITEM_STATUSES)[number]

/** Statuses from which nothing further happens without an explicit reopen. */
export const TERMINAL_CODE_WORK_ITEM_STATUSES: readonly CodeWorkItemStatus[] = ['closed']

/**
 * What arrived from the code host. Deliberately classified BEFORE reaching this
 * module: the machine reasons about "a head change" / "a confirmation", never
 * about webhook payload shapes.
 */
export type CodeExternalSignal =
  | { kind: 'head-changed'; sha: string }
  | { kind: 'confirmation'; generation: number }
  | { kind: 'note' }
  | { kind: 'pipeline' }
  | { kind: 'closure'; cause: 'merged' | 'closed' | 'thread-resolved' | 'pipeline-green' }

export type CodeWorkItemEvent =
  | { kind: 'external-signal'; signal: CodeExternalSignal }
  | { kind: 'scheduler-take' }
  | { kind: 'round-published' }
  | { kind: 'round-needs-human'; pendingGeneration: number }
  | { kind: 'round-failed' }
  | { kind: 'quota-exhausted'; failureFingerprint: string }
  /** The previously-running task reached a terminal status. */
  | { kind: 'round-task-terminal' }
  | { kind: 'manual-retry' }
  /** Cancellation + lease release finished; `closing` may finalize. */
  | { kind: 'compensation-complete' }

export interface CodeWorkItemContext {
  status: CodeWorkItemStatus
  /** Bumped whenever an in-flight round is abandoned; rounds carry it. */
  epoch: number
  /** Set while `awaiting`: which patch generation the human was asked about. */
  pendingGeneration: number | null
  /** True while a round's task has not yet reached a terminal status. */
  hasLiveRound: boolean
  /** Set while `handed_off`: the failure fingerprint that exhausted its quota. */
  handedOffFingerprint: string | null
  /**
   * Which stage a resumed round restarts from, per the capability's declared
   * `resumeFrom` (design §2.2 "恢复语义"). Null = start from the beginning.
   */
  resumeFromStage: string | null
}

export type CodeWorkItemEffect =
  /** Ask task-execution to cancel the live round's task. */
  | { kind: 'request-round-cancel' }
  | { kind: 'bump-epoch' }
  | { kind: 'start-round'; resumeFromStage: string | null }
  | { kind: 'record-wait-handle'; pendingGeneration: number }
  | { kind: 'clear-wait-handle' }
  | { kind: 'record-ledger' }
  /** Tell the human on the MR why nothing will come of their request. */
  | { kind: 'post-invalidation'; reason: 'baseline-changed' | 'stale-confirmation' }
  /** Summarize every attempt of this campaign, then stop auto-opening rounds. */
  | { kind: 'post-handoff-summary'; failureFingerprint: string }
  /**
   * A new head while handed off buys a `collect + classify` PRE-CHECK, not a
   * new campaign — see `decideCodeWorkItemTransition`'s handed_off arm.
   */
  | { kind: 'precheck-failure-fingerprint' }
  | { kind: 'final-adoption-comparison' }

export type CodeWorkItemDecision =
  | { outcome: 'transition'; to: CodeWorkItemStatus; effects: CodeWorkItemEffect[] }
  /** Legal, but the status does not change; effects may still run. */
  | { outcome: 'stay'; effects: CodeWorkItemEffect[]; reason: string }
  /** The event does not apply to this status at all. */
  | { outcome: 'rejected'; reason: string }

const t = (to: CodeWorkItemStatus, effects: CodeWorkItemEffect[] = []): CodeWorkItemDecision => ({
  outcome: 'transition',
  to,
  effects,
})
const stay = (reason: string, effects: CodeWorkItemEffect[] = []): CodeWorkItemDecision => ({
  outcome: 'stay',
  effects,
  reason,
})
const no = (reason: string): CodeWorkItemDecision => ({ outcome: 'rejected', reason })

/**
 * Decide what one event does to a work item. Pure: no clock, no db, no ids.
 *
 * The caller CAS-writes `to` (guarded on `ctx.status`) and runs `effects` in
 * order. Effects are described, not performed, so that "what should happen"
 * stays reviewable next to the transition table it comes from.
 */
export function decideCodeWorkItemTransition(
  ctx: CodeWorkItemContext,
  event: CodeWorkItemEvent,
): CodeWorkItemDecision {
  const { status } = ctx

  if (status === 'closed') {
    return no('a closed work item is terminal; reopening is an explicit new item')
  }

  // ── External closure outranks everything except being already closing ──────
  // Placed FIRST because it applies "from any non-closed/closing status": if it
  // sat in the per-status arms below it would have to be repeated eight times,
  // and the one arm someone forgot would keep running rounds against a merged
  // MR — the exact shape RFC-303 built its terminal fences for.
  if (event.kind === 'external-signal' && event.signal.kind === 'closure') {
    if (status === 'closing') return stay('already converging on closed')
    return t('closing', [
      { kind: 'bump-epoch' },
      ...(ctx.hasLiveRound ? [{ kind: 'request-round-cancel' } as const] : []),
    ])
  }

  if (status === 'closing') {
    // Only two things matter now: the old task dying and compensation landing.
    if (event.kind === 'round-task-terminal') {
      return ctx.hasLiveRound
        ? stay('task terminal observed; still awaiting compensation')
        : stay('no live round; awaiting compensation')
    }
    if (event.kind === 'compensation-complete') {
      if (ctx.hasLiveRound) return stay('compensation done but the round task is still live')
      return t('closed', [{ kind: 'final-adoption-comparison' }])
    }
    return stay('closing: ignoring everything but task-terminal / compensation')
  }

  switch (event.kind) {
    case 'external-signal': {
      const signal = event.signal
      // Guard 1 — baseline change wins over every other reading of the event.
      if (signal.kind === 'head-changed') {
        if (status === 'awaiting') {
          return t('settled', [
            { kind: 'clear-wait-handle' },
            { kind: 'post-invalidation', reason: 'baseline-changed' },
            { kind: 'record-ledger' },
          ])
        }
        if (status === 'handed_off') {
          // NOT a release. The first draft released on any new head, so pushing
          // an unrelated README fix bought three fresh rounds for the SAME
          // compile error — precisely what the quota exists to prevent. A new
          // head only buys a pre-check; the fingerprint has to actually differ.
          return stay('handed off: a new head only buys a fingerprint pre-check', [
            { kind: 'precheck-failure-fingerprint' },
          ])
        }
        return externalArrival(ctx)
      }
      // Guard 2 — a confirmation must name the generation it answers.
      if (signal.kind === 'confirmation') {
        if (status !== 'awaiting') return externalArrival(ctx)
        if (ctx.pendingGeneration === null || signal.generation !== ctx.pendingGeneration) {
          return stay('confirmation does not match the pending generation', [
            { kind: 'post-invalidation', reason: 'stale-confirmation' },
          ])
        }
        return t('queued', [
          { kind: 'clear-wait-handle' },
          { kind: 'start-round', resumeFromStage: ctx.resumeFromStage },
        ])
      }
      // Guard 3 — notes and pipeline events never wake a waiting item.
      if (status === 'awaiting') {
        return stay('ordinary events do not wake an item awaiting a confirmation')
      }
      if (status === 'handed_off') {
        return stay('handed off: ordinary events do not open a new campaign')
      }
      return externalArrival(ctx)
    }

    case 'scheduler-take':
      if (status !== 'queued') return no(`scheduler-take applies to 'queued', not '${status}'`)
      return t('running')

    case 'round-published':
      if (status !== 'running') return no(`round-published applies to 'running', not '${status}'`)
      return t('settled', [{ kind: 'record-ledger' }])

    case 'round-needs-human':
      if (status !== 'running') return no(`round-needs-human applies to 'running', not '${status}'`)
      return t('awaiting', [
        { kind: 'record-wait-handle', pendingGeneration: event.pendingGeneration },
      ])

    case 'round-failed':
      if (status !== 'running') return no(`round-failed applies to 'running', not '${status}'`)
      // Platform-side alert only; the MR stays silent (design §2.2).
      return t('failed')

    case 'quota-exhausted':
      if (status !== 'running') return no(`quota-exhausted applies to 'running', not '${status}'`)
      return t('handed_off', [
        { kind: 'post-handoff-summary', failureFingerprint: event.failureFingerprint },
      ])

    case 'round-task-terminal':
      if (status !== 'superseding') {
        return stay(`round-task-terminal is only decisive while superseding (now '${status}')`)
      }
      return t('queued', [{ kind: 'start-round', resumeFromStage: null }])

    case 'manual-retry':
      if (status !== 'failed' && status !== 'handed_off') {
        return no(`manual-retry applies to 'failed'/'handed_off', not '${status}'`)
      }
      return t('queued', [{ kind: 'start-round', resumeFromStage: null }])

    case 'compensation-complete':
      return stay('compensation only finalizes a closing item')
  }
}

/**
 * What an ordinary external arrival does, once the three guards above have had
 * their say. Split out because five arms funnel into it and inlining it made
 * the guard order harder to read than the rules it implements.
 */
function externalArrival(ctx: CodeWorkItemContext): CodeWorkItemDecision {
  switch (ctx.status) {
    case 'idle':
    case 'settled':
    case 'failed':
      return t('queued', [{ kind: 'start-round', resumeFromStage: null }])
    case 'queued':
      // Already scheduled — collapsing a burst of events into one round is the
      // point, not a missed transition.
      return stay('already queued; the pending round will see the latest state')
    case 'running':
      // Do NOT open the new round here: the old task has to die first, or two
      // rounds would write the same worktree. `superseding` is that wait.
      return t('superseding', [{ kind: 'bump-epoch' }, { kind: 'request-round-cancel' }])
    case 'superseding':
      return stay('already superseding; the new round starts when the old task dies')
    default:
      return stay(`no external-arrival rule for '${ctx.status}'`)
  }
}
