// RFC-304 T3 — the work item transition table, exhaustively.
//
// This file is deliberately paranoid about ONE thing: guard order. The happy
// path (event → new status) is easy and an integration test would catch a
// break. What no integration test catches is the case where a single real-world
// event matches several table rows at once — a teammate pushing a commit while
// the item awaits a human is both "an external event arrived" and "the baseline
// changed" — because the wrong resolution still produces a plausible-looking
// state. Design §2.2 fixes an explicit priority for exactly that reason, so the
// priority itself is what gets locked here.
//
// The second thing locked here is `handed_off`'s release condition. The first
// draft released on ANY new head, which meant pushing an unrelated README fix
// bought three fresh rounds against the same compile error — it drove straight
// around the quota it was supposed to enforce. That is a rule with a
// counter-intuitive shape (a new commit does NOT resume work), so it needs a
// test that states the intent, not just the behaviour.

import { describe, expect, test } from 'bun:test'
import {
  CODE_WORK_ITEM_STATUSES,
  decideCodeWorkItemTransition,
  type CodeWorkItemContext,
  type CodeWorkItemEffect,
  type CodeWorkItemEvent,
  type CodeWorkItemStatus,
} from '../src/modules/code-capability/domain/workItemLifecycle'

const ctxOf = (over: Partial<CodeWorkItemContext> = {}): CodeWorkItemContext => ({
  status: 'idle',
  epoch: 1,
  pendingGeneration: null,
  hasLiveRound: false,
  handedOffFingerprint: null,
  resumeFromStage: null,
  ...over,
})

const effectKinds = (effects: readonly CodeWorkItemEffect[]): string[] => effects.map((e) => e.kind)

/** The decision's `to`, or null when the status does not change. */
function toOf(ctx: CodeWorkItemContext, event: CodeWorkItemEvent): CodeWorkItemStatus | null {
  const d = decideCodeWorkItemTransition(ctx, event)
  return d.outcome === 'transition' ? d.to : null
}

const HEAD_CHANGED: CodeWorkItemEvent = {
  kind: 'external-signal',
  signal: { kind: 'head-changed', sha: 'abc123' },
}
const NOTE: CodeWorkItemEvent = { kind: 'external-signal', signal: { kind: 'note' } }
const PIPELINE: CodeWorkItemEvent = { kind: 'external-signal', signal: { kind: 'pipeline' } }
const confirmation = (generation: number): CodeWorkItemEvent => ({
  kind: 'external-signal',
  signal: { kind: 'confirmation', generation },
})
const MERGED: CodeWorkItemEvent = {
  kind: 'external-signal',
  signal: { kind: 'closure', cause: 'merged' },
}

describe('RFC-304 §2.2 — guard priority (the part table order cannot express)', () => {
  test('guard 1: a head change while awaiting invalidates, never wakes', () => {
    // The colliding case: this event ALSO satisfies "external event arrived",
    // whose row says awaiting → queued. Baseline change must win.
    const d = decideCodeWorkItemTransition(
      ctxOf({ status: 'awaiting', pendingGeneration: 7 }),
      HEAD_CHANGED,
    )
    expect(d.outcome).toBe('transition')
    expect(d.outcome === 'transition' && d.to).toBe('settled')
    // Silently settling would leave a human waiting for a reply that never
    // comes — the invalidation notice is part of the transition, not a nicety.
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toContain('post-invalidation')
    const notice = (d.outcome === 'transition' ? d.effects : []).find(
      (e) => e.kind === 'post-invalidation',
    )
    expect(notice?.kind === 'post-invalidation' && notice.reason).toBe('baseline-changed')
    // And it must NOT open a round: there is nothing to answer any more.
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).not.toContain('start-round')
  })

  test('guard 2: only a generation-matched confirmation wakes an awaiting item', () => {
    const waiting = ctxOf({ status: 'awaiting', pendingGeneration: 7 })

    const matched = decideCodeWorkItemTransition(waiting, confirmation(7))
    expect(matched.outcome === 'transition' && matched.to).toBe('queued')

    // A confirmation aimed at a patch that has since been superseded. Acting on
    // it would push work the human never actually approved.
    const stale = decideCodeWorkItemTransition(waiting, confirmation(6))
    expect(stale.outcome).toBe('stay')
    expect(effectKinds(stale.outcome === 'stay' ? stale.effects : [])).toEqual([
      'post-invalidation',
    ])
    const notice = (stale.outcome === 'stay' ? stale.effects : []).find(
      (e) => e.kind === 'post-invalidation',
    )
    expect(notice?.kind === 'post-invalidation' && notice.reason).toBe('stale-confirmation')
  })

  test('guard 2b: a confirmation with no pending generation is never honoured', () => {
    const d = decideCodeWorkItemTransition(
      ctxOf({ status: 'awaiting', pendingGeneration: null }),
      confirmation(1),
    )
    expect(d.outcome).toBe('stay')
  })

  test('guard 3: notes and pipeline events do not wake an awaiting item', () => {
    for (const event of [NOTE, PIPELINE]) {
      const d = decideCodeWorkItemTransition(
        ctxOf({ status: 'awaiting', pendingGeneration: 7 }),
        event,
      )
      expect(d.outcome).toBe('stay')
      expect(effectKinds(d.outcome === 'stay' ? d.effects : [])).toEqual([])
    }
  })

  test('the same signal reads differently by status — which is the whole point', () => {
    // One event object, four statuses, four intended readings. If guard order
    // ever collapses, at least one of these silently becomes another.
    expect(toOf(ctxOf({ status: 'idle' }), HEAD_CHANGED)).toBe('queued')
    expect(toOf(ctxOf({ status: 'running', hasLiveRound: true }), HEAD_CHANGED)).toBe('superseding')
    expect(toOf(ctxOf({ status: 'awaiting', pendingGeneration: 1 }), HEAD_CHANGED)).toBe('settled')
    expect(
      toOf(ctxOf({ status: 'handed_off', handedOffFingerprint: 'f1' }), HEAD_CHANGED),
    ).toBeNull()
  })
})

describe('RFC-304 §2.2 — superseding never opens the new round early', () => {
  test('a new event while running cancels and bumps epoch, but starts nothing', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'running', hasLiveRound: true }), NOTE)
    expect(d.outcome === 'transition' && d.to).toBe('superseding')
    const effects = effectKinds(d.outcome === 'transition' ? d.effects : [])
    expect(effects).toContain('bump-epoch')
    expect(effects).toContain('request-round-cancel')
    // Two rounds writing one worktree is the failure this wait exists to stop.
    expect(effects).not.toContain('start-round')
  })

  test('the new round opens only once the old task is actually terminal', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'superseding' }), {
      kind: 'round-task-terminal',
    })
    expect(d.outcome === 'transition' && d.to).toBe('queued')
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toContain('start-round')
  })

  test('further events while superseding do not stack up more rounds', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'superseding' }), NOTE)
    expect(d.outcome).toBe('stay')
  })
})

describe('RFC-304 §2.2 — handed_off is a quota, not a pause', () => {
  const handedOff = ctxOf({ status: 'handed_off', handedOffFingerprint: 'compile-error-1' })

  test('a new head buys a fingerprint pre-check, NOT a new campaign', () => {
    const d = decideCodeWorkItemTransition(handedOff, HEAD_CHANGED)
    expect(d.outcome).toBe('stay')
    expect(effectKinds(d.outcome === 'stay' ? d.effects : [])).toEqual([
      'precheck-failure-fingerprint',
    ])
  })

  test('ordinary events do not release it either', () => {
    for (const event of [NOTE, PIPELINE]) {
      expect(decideCodeWorkItemTransition(handedOff, event).outcome).toBe('stay')
    }
  })

  test('an explicit human retry DOES release it — that is the intended door', () => {
    const d = decideCodeWorkItemTransition(handedOff, { kind: 'manual-retry' })
    expect(d.outcome === 'transition' && d.to).toBe('queued')
  })

  test('exhausting the quota summarizes every attempt before going quiet', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'running', hasLiveRound: true }), {
      kind: 'quota-exhausted',
      failureFingerprint: 'compile-error-1',
    })
    expect(d.outcome === 'transition' && d.to).toBe('handed_off')
    // Going silent without the summary strands whoever picks it up.
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toContain(
      'post-handoff-summary',
    )
  })
})

describe('RFC-304 §2.2 — closure outranks every other status', () => {
  test('every non-closed, non-closing status converges on closing', () => {
    // Written as a sweep on purpose: the rule is "from ANY status", and the
    // failure mode is one arm someone forgot — which would keep running rounds
    // against a merged MR.
    for (const status of CODE_WORK_ITEM_STATUSES) {
      if (status === 'closed' || status === 'closing') continue
      const d = decideCodeWorkItemTransition(ctxOf({ status, hasLiveRound: true }), MERGED)
      expect(d.outcome === 'transition' && d.to).toBe('closing')
      expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toContain(
        'request-round-cancel',
      )
    }
  })

  test('closure with no live round skips the cancel', () => {
    const d = decideCodeWorkItemTransition(
      ctxOf({ status: 'settled', hasLiveRound: false }),
      MERGED,
    )
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).not.toContain(
      'request-round-cancel',
    )
  })

  test('closing waits for BOTH the task to die and compensation to land', () => {
    const live = ctxOf({ status: 'closing', hasLiveRound: true })
    // Compensation alone is not enough while a task is still running.
    expect(decideCodeWorkItemTransition(live, { kind: 'compensation-complete' }).outcome).toBe(
      'stay',
    )
    const settled = ctxOf({ status: 'closing', hasLiveRound: false })
    const d = decideCodeWorkItemTransition(settled, { kind: 'compensation-complete' })
    expect(d.outcome === 'transition' && d.to).toBe('closed')
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toContain(
      'final-adoption-comparison',
    )
  })

  test('a closing item ignores ordinary traffic', () => {
    for (const event of [NOTE, PIPELINE, HEAD_CHANGED]) {
      expect(decideCodeWorkItemTransition(ctxOf({ status: 'closing' }), event).outcome).toBe('stay')
    }
  })
})

describe('RFC-304 §2.2 — closed is terminal, and every status has a defined answer', () => {
  const ALL_EVENTS: CodeWorkItemEvent[] = [
    HEAD_CHANGED,
    NOTE,
    PIPELINE,
    confirmation(1),
    MERGED,
    { kind: 'scheduler-take' },
    { kind: 'round-published' },
    { kind: 'round-needs-human', pendingGeneration: 1 },
    { kind: 'round-failed' },
    { kind: 'quota-exhausted', failureFingerprint: 'f' },
    { kind: 'round-task-terminal' },
    { kind: 'manual-retry' },
    { kind: 'compensation-complete' },
  ]

  test('closed refuses everything', () => {
    for (const event of ALL_EVENTS) {
      expect(decideCodeWorkItemTransition(ctxOf({ status: 'closed' }), event).outcome).toBe(
        'rejected',
      )
    }
  })

  test('no (status, event) pair falls through undefined', () => {
    // The real assertion is "the function is total". A missing arm in a switch
    // over a growing union is the classic way a state machine acquires an
    // unreachable-but-reachable hole.
    for (const status of CODE_WORK_ITEM_STATUSES) {
      for (const event of ALL_EVENTS) {
        const d = decideCodeWorkItemTransition(ctxOf({ status }), event)
        expect(['transition', 'stay', 'rejected']).toContain(d.outcome)
        if (d.outcome === 'transition') {
          expect(CODE_WORK_ITEM_STATUSES).toContain(d.to)
        } else {
          expect(d.reason.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test('a transition never both settles and starts a round', () => {
    // Contradictory effect pairs are how a machine ends up with two live rounds
    // or a ledger entry for work that never ran.
    for (const status of CODE_WORK_ITEM_STATUSES) {
      for (const event of ALL_EVENTS) {
        const d = decideCodeWorkItemTransition(ctxOf({ status, pendingGeneration: 1 }), event)
        const kinds = effectKinds(d.outcome === 'rejected' ? [] : d.effects)
        if (kinds.includes('start-round')) {
          expect(kinds).not.toContain('record-ledger')
          expect(kinds).not.toContain('post-handoff-summary')
        }
      }
    }
  })
})

describe('RFC-304 §2.2 — the ordinary path still works', () => {
  test('idle → queued → running → settled', () => {
    expect(toOf(ctxOf({ status: 'idle' }), NOTE)).toBe('queued')
    expect(toOf(ctxOf({ status: 'queued' }), { kind: 'scheduler-take' })).toBe('running')
    expect(toOf(ctxOf({ status: 'running' }), { kind: 'round-published' })).toBe('settled')
  })

  test('running → awaiting records the handle the reply will be matched against', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'running' }), {
      kind: 'round-needs-human',
      pendingGeneration: 3,
    })
    expect(d.outcome === 'transition' && d.to).toBe('awaiting')
    const handle = (d.outcome === 'transition' ? d.effects : []).find(
      (e) => e.kind === 'record-wait-handle',
    )
    // Without the generation the item cannot tell a fresh confirmation from a
    // late one, and guard 2 degrades to "any confirmation wakes it".
    expect(handle?.kind === 'record-wait-handle' && handle.pendingGeneration).toBe(3)
  })

  test('a resumed round restarts from the capability’s declared stage', () => {
    const d = decideCodeWorkItemTransition(
      ctxOf({ status: 'awaiting', pendingGeneration: 2, resumeFromStage: 'apply-patch' }),
      confirmation(2),
    )
    const start = (d.outcome === 'transition' ? d.effects : []).find(
      (e) => e.kind === 'start-round',
    )
    // Re-running from the top would re-post every finding the human just read.
    expect(start?.kind === 'start-round' && start.resumeFromStage).toBe('apply-patch')
  })

  test('a burst of events while queued collapses into the one pending round', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'queued' }), NOTE)
    expect(d.outcome).toBe('stay')
    expect(effectKinds(d.outcome === 'stay' ? d.effects : [])).toEqual([])
  })

  test('failure is platform-visible but MR-silent', () => {
    const d = decideCodeWorkItemTransition(ctxOf({ status: 'running' }), { kind: 'round-failed' })
    expect(d.outcome === 'transition' && d.to).toBe('failed')
    // Design §2.2: "平台内告警，MR 静默" — no comment effect on this edge.
    expect(effectKinds(d.outcome === 'transition' ? d.effects : [])).toEqual([])
  })

  test('a failed item is revived by a new event as well as by a human', () => {
    expect(toOf(ctxOf({ status: 'failed' }), NOTE)).toBe('queued')
    expect(toOf(ctxOf({ status: 'failed' }), { kind: 'manual-retry' })).toBe('queued')
  })
})
