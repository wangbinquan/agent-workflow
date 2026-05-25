// RFC-061 PR-A T2 — buildPromptFromEvents aging tests.
//
// LOCKS the single-predicate aging contract: a `suspension-resolved` event
// at iter N feeds the prompt only when N >= baselineIter, where
// baselineIter = MAX(iter) over all `attempt-output-captured` events on
// the same (nodeId, loopIter, shardKey) prefix.
//
// design.md §10 says this replaces today's computeHistoryCutoff + 3
// consumerKind branches across 4 files with a single < 30 line pure
// function.

import { describe, expect, test } from 'bun:test'

import {
  buildPromptFromEvents,
  computeBaselineIter,
  selectFreshResolutions,
  PROMPT_CONSUMED_EVENT_KINDS,
} from '../src/promptFromEvents'
import { decodeEvent, type Event, type RawEvent, type Scope } from '../src/events'
import { type SignalKindHandler, type SignalKindHandlerRegistry } from '../src/handlers'

const FULL_SCOPE: Scope = { nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 5 }

let evtCounter = 0
function nextEvtId(): string {
  evtCounter += 1
  return `evt_${String(evtCounter).padStart(4, '0')}`
}

function makeRaw(overrides: Partial<RawEvent>): RawEvent {
  return {
    id: nextEvtId(),
    taskId: 'task_1',
    ts: 1000 + evtCounter,
    kind: 'task-started',
    nodeId: null,
    loopIter: null,
    shardKey: null,
    iter: null,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload: '{}',
    ...overrides,
  }
}

function captured(scope: Pick<Scope, 'nodeId' | 'loopIter' | 'shardKey' | 'iter'>): Event {
  return decodeEvent(
    makeRaw({
      kind: 'attempt-output-captured',
      nodeId: scope.nodeId,
      loopIter: scope.loopIter,
      shardKey: scope.shardKey,
      iter: scope.iter,
      attemptId: 'att_x',
      payload: JSON.stringify({ portName: 'out', content: 'x' }),
    }),
  )
}

function resolved(
  scope: Pick<Scope, 'nodeId' | 'loopIter' | 'shardKey' | 'iter'>,
  signalKind: string,
  decision: unknown,
  resolutionId?: string,
): Event {
  return decodeEvent(
    makeRaw({
      kind: 'suspension-resolved',
      nodeId: scope.nodeId,
      loopIter: scope.loopIter,
      shardKey: scope.shardKey,
      iter: scope.iter,
      resolutionId: resolutionId ?? `res_${nextEvtId()}`,
      payload: JSON.stringify({
        suspensionId: 'sus_x',
        signalKind,
        decision,
      }),
    }),
  )
}

/** Stub registry that just stringifies the resolution count by signalKind. */
function makeRegistry(): SignalKindHandlerRegistry {
  const make = (sig: string): SignalKindHandler<'self-clarify'> => ({
    kind: 'self-clarify',
    async onSuspend() {
      return []
    },
    validateResolution() {
      return { valid: true }
    },
    async applyResolution() {
      return []
    },
    effectOnLogicalRun() {
      return 'bump-iter'
    },
    renderPromptSection(events) {
      return events.length === 0 ? '' : `[${sig}-${events.length}]`
    },
  })
  return {
    'self-clarify': make('self'),
    'cross-clarify': make('cross') as unknown as SignalKindHandler<'cross-clarify'>,
    review: make('review') as unknown as SignalKindHandler<'review'>,
  }
}

/* ============================================================
 *  computeBaselineIter
 * ============================================================ */

describe('computeBaselineIter', () => {
  test('-1 when no captured output exists for the scope', () => {
    expect(computeBaselineIter([], FULL_SCOPE)).toBe(-1)
  })

  test('returns the max iter of attempt-output-captured for the scope prefix', () => {
    const events = [
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 2 }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 1 }),
    ]
    expect(computeBaselineIter(events, FULL_SCOPE)).toBe(2)
  })

  test('ignores captured output for other nodes', () => {
    const events = [
      captured({ nodeId: 'OTHER', loopIter: 0, shardKey: '', iter: 9 }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 1 }),
    ]
    expect(computeBaselineIter(events, FULL_SCOPE)).toBe(1)
  })

  test('ignores captured output in different shards', () => {
    const events = [
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: 'shard_x', iter: 9 }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 }),
    ]
    expect(computeBaselineIter(events, FULL_SCOPE)).toBe(0)
  })

  test('ignores captured output in different loop iter', () => {
    const events = [
      captured({ nodeId: 'n_a', loopIter: 1, shardKey: '', iter: 9 }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 }),
    ]
    expect(computeBaselineIter(events, FULL_SCOPE)).toBe(0)
  })
})

/* ============================================================
 *  selectFreshResolutions
 * ============================================================ */

describe('selectFreshResolutions', () => {
  test('returns empty when no suspension-resolved events exist', () => {
    expect(selectFreshResolutions([captured(FULL_SCOPE)], FULL_SCOPE, 0)).toEqual([])
  })

  test('keeps every resolution when baselineIter = -1', () => {
    const events = [
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', { a: 1 }),
      resolved({ ...FULL_SCOPE, iter: 1 }, 'self-clarify', { a: 2 }),
    ]
    expect(selectFreshResolutions(events, FULL_SCOPE, -1)).toHaveLength(2)
  })

  test('drops resolutions strictly older than baselineIter', () => {
    const events = [
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', { a: 'stale' }),
      resolved({ ...FULL_SCOPE, iter: 2 }, 'self-clarify', { a: 'fresh' }),
    ]
    const fresh = selectFreshResolutions(events, FULL_SCOPE, 2)
    expect(fresh).toHaveLength(1)
    if (fresh[0]?.kind !== 'suspension-resolved') throw new Error('kind narrow failed')
    expect((fresh[0].payload as { decision: { a: string } }).decision.a).toBe('fresh')
  })

  test('keeps resolution exactly at baselineIter (>= not >)', () => {
    const events = [resolved({ ...FULL_SCOPE, iter: 3 }, 'self-clarify', {})]
    expect(selectFreshResolutions(events, FULL_SCOPE, 3)).toHaveLength(1)
  })

  test('drops resolutions for other scopes', () => {
    const events = [
      resolved({ nodeId: 'OTHER', loopIter: 0, shardKey: '', iter: 9 }, 'self-clarify', {}),
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', {}),
    ]
    expect(selectFreshResolutions(events, FULL_SCOPE, -1)).toHaveLength(1)
  })

  test('drops retry-pending-* signals (control flow, not feedback)', () => {
    const events = [
      resolved({ ...FULL_SCOPE, iter: 0 }, 'retry-pending-auto', {}),
      resolved({ ...FULL_SCOPE, iter: 0 }, 'retry-pending-human', {}),
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', {}),
    ]
    expect(selectFreshResolutions(events, FULL_SCOPE, -1)).toHaveLength(1)
  })
})

/* ============================================================
 *  buildPromptFromEvents end-to-end
 * ============================================================ */

describe('buildPromptFromEvents', () => {
  test('returns empty sections when no events exist', () => {
    const ctx = buildPromptFromEvents([], FULL_SCOPE, makeRegistry())
    expect(ctx.selfClarifyQA).toBe('')
    expect(ctx.externalFeedback).toBe('')
    expect(ctx.reviewerFeedback).toBe('')
  })

  test('aggregates resolutions by signalKind into per-section strings', () => {
    const events = [
      resolved(FULL_SCOPE, 'self-clarify', {}),
      resolved(FULL_SCOPE, 'self-clarify', {}),
      resolved(FULL_SCOPE, 'cross-clarify', {}),
      resolved(FULL_SCOPE, 'review', {}),
    ]
    const ctx = buildPromptFromEvents(events, FULL_SCOPE, makeRegistry())
    expect(ctx.selfClarifyQA).toBe('[self-2]')
    expect(ctx.externalFeedback).toBe('[cross-1]')
    expect(ctx.reviewerFeedback).toBe('[review-1]')
  })

  test('aging cutoff: resolutions before captured output are excluded', () => {
    const events = [
      // stale: resolved at iter 0, then output captured at iter 0 → aged out for iter > 0
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', { a: 'stale' }),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 1 }),
      // fresh: resolved at iter 1 (>= baseline 1)
      resolved({ ...FULL_SCOPE, iter: 1 }, 'self-clarify', { a: 'fresh' }),
    ]
    const ctx = buildPromptFromEvents(events, FULL_SCOPE, makeRegistry())
    // Only one self-clarify Q&A survives — the iter=1 resolution
    expect(ctx.selfClarifyQA).toBe('[self-1]')
  })

  test('missing registry entry yields empty string (graceful)', () => {
    const events = [resolved(FULL_SCOPE, 'self-clarify', {})]
    const ctx = buildPromptFromEvents(events, FULL_SCOPE, {})
    expect(ctx.selfClarifyQA).toBe('')
  })

  test('still works after baseline advances (older resolutions drop)', () => {
    const events = [
      resolved({ ...FULL_SCOPE, iter: 0 }, 'self-clarify', {}),
      captured({ nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 5 }),
      // No fresh resolutions after the new baseline
    ]
    const ctx = buildPromptFromEvents(events, FULL_SCOPE, makeRegistry())
    expect(ctx.selfClarifyQA).toBe('')
  })

  test('PROMPT_CONSUMED_EVENT_KINDS is locked to two kinds', () => {
    expect(PROMPT_CONSUMED_EVENT_KINDS.size).toBe(2)
    expect(PROMPT_CONSUMED_EVENT_KINDS.has('attempt-output-captured')).toBe(true)
    expect(PROMPT_CONSUMED_EVENT_KINDS.has('suspension-resolved')).toBe(true)
  })
})
